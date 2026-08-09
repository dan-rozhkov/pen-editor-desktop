export type UITheme = "light" | "dark";

// Mirrors src/main/mcp/service.ts's McpStatus — defined here (rather than
// imported from mcp/service.ts) so this module stays free of any dependency
// on the MCP bridge; service.ts is the one that imports this type. "off"
// means no local MCP server is running at all (should not normally happen
// once the app has started); "not-published" means our server is up but a
// different local process already owns the handshake file; "listening"
// means our server is the one a plugin/agent will discover; "error" means
// something that should have worked (binding the loopback server, writing
// the handshake file) failed outright — this must render as visibly as
// "not-published" (never as hidden "off"), since the status surface is the
// only diagnostic a packaged user has (finding 1/3).
export type McpStatus = "listening" | "not-published" | "off" | "error";

export interface TabViewHandle {
  loadURL(url: string): void;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setVisible(visible: boolean): void;
  destroy(): void;
  sendMenuCommand(commandId: string): void;
  focus(): void;
  onDocumentTitleChanged(cb: (title: string) => void): void;
  onThemeChanged(cb: (theme: UITheme) => void): void;
  /**
   * The webContents id backing this tab — a different id space from
   * TabManager's own sequential `id` (TabsSnapshot.activeId etc). Needed by
   * window.ts to translate "the currently active tab" into the id
   * mcp/service.ts's tab registry is actually keyed by (see
   * McpService.registerTab/setActiveTab, both keyed by webContents.id).
   */
  getWebContentsId(): number;
}

export interface TabState {
  id: number;
  title: string;
}

export interface TabsSnapshot {
  tabs: TabState[];
  activeId: number | null;
  activeTheme: UITheme | null;
  mcpStatus: McpStatus;
}

interface TabEntry {
  id: number;
  title: string;
  view: TabViewHandle;
  theme: UITheme | null;
}

/**
 * Owns the ordered list of editor tabs. Pure logic — Electron's
 * WebContentsView is injected via `createView` so this is unit-testable.
 */
export class TabManager {
  private tabs: TabEntry[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  private mcpStatus: McpStatus = "off";
  private lastLayout: { content: { width: number; height: number }; tabbarHeight: number } | null =
    null;

  constructor(
    private readonly opts: {
      createView: () => TabViewHandle;
      editorUrl: string;
      onStateChanged: (s: TabsSnapshot) => void;
    },
  ) {}

  newTab(): number {
    const id = this.nextId++;
    const view = this.opts.createView();
    const entry: TabEntry = { id, title: "Untitled", view, theme: null };
    view.onDocumentTitleChanged((title) => {
      entry.title = title;
      this.emit();
    });
    view.onThemeChanged((theme) => {
      if (entry.theme === theme) return;
      entry.theme = theme;
      this.emit();
    });
    this.tabs.push(entry);
    view.loadURL(this.opts.editorUrl);
    if (this.lastLayout) this.applyLayout(entry);
    this.setActive(id);
    return id;
  }

  closeTab(id: number): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [closed] = this.tabs.splice(idx, 1);
    if (this.tabs.length === 0) {
      this.activeId = null;
      this.newTab(); // newTab emits
    } else if (this.activeId === id) {
      const neighbor = this.tabs[Math.max(0, idx - 1)];
      this.setActive(neighbor.id); // setActive emits
    } else {
      this.emit();
    }
    try {
      closed.view.destroy();
    } catch (err) {
      console.error("TabManager: closed tab view failed to destroy", err);
    }
  }

  activate(id: number): void {
    if (this.tabs.some((t) => t.id === id)) this.setActive(id);
  }

  nextTab(): void {
    this.cycle(1);
  }

  prevTab(): void {
    this.cycle(-1);
  }

  activeHandle(): TabViewHandle | null {
    return this.tabs.find((t) => t.id === this.activeId)?.view ?? null;
  }

  getSnapshot(): TabsSnapshot {
    return {
      tabs: this.tabs.map(({ id, title }) => ({ id, title })),
      activeId: this.activeId,
      activeTheme: this.tabs.find((tab) => tab.id === this.activeId)?.theme ?? null,
      mcpStatus: this.mcpStatus,
    };
  }

  /**
   * Reports the desktop MCP bridge's publish status (see mcp/service.ts)
   * into the snapshot the tab bar renders — the tab strip's only diagnostic,
   * since a packaged app has no terminal. TabManager does not know anything
   * about MCP itself; window.ts is the one wiring service status changes
   * here, the same way it wires editor theme/title callbacks above.
   */
  setMcpStatus(status: McpStatus): void {
    if (status === this.mcpStatus) return;
    this.mcpStatus = status;
    this.emit();
  }

  layout(content: { width: number; height: number }, tabbarHeight: number): void {
    this.lastLayout = { content, tabbarHeight };
    for (const tab of this.tabs) this.applyLayout(tab);
  }

  count(): number {
    return this.tabs.length;
  }

  /**
   * Destroys every tab view without respawning a replacement — unlike
   * closeTab(), which always keeps at least one tab open. Intended for
   * window teardown (win.on("closed", ...)).
   */
  destroyAll(): void {
    const closing = this.tabs;
    this.tabs = [];
    this.activeId = null;
    for (const tab of closing) {
      try {
        tab.view.destroy();
      } catch (err) {
        console.error("TabManager: tab view failed to destroy", err);
      }
    }
  }

  private applyLayout(tab: TabEntry): void {
    if (!this.lastLayout) return;
    const { content, tabbarHeight } = this.lastLayout;
    tab.view.setBounds({
      x: 0,
      y: tabbarHeight,
      width: content.width,
      height: Math.max(0, content.height - tabbarHeight),
    });
  }

  private cycle(delta: number): void {
    if (this.tabs.length === 0 || this.activeId === null) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = this.tabs[(idx + delta + this.tabs.length) % this.tabs.length];
    this.setActive(next.id);
  }

  private setActive(id: number): void {
    this.activeId = id;
    for (const tab of this.tabs) tab.view.setVisible(tab.id === id);
    this.tabs.find((t) => t.id === id)?.view.focus();
    this.emit();
  }

  private emit(): void {
    this.opts.onStateChanged(this.getSnapshot());
  }
}
