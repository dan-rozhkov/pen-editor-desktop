export interface TabViewHandle {
  loadURL(url: string): void;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setVisible(visible: boolean): void;
  destroy(): void;
  sendMenuCommand(commandId: string): void;
  focus(): void;
  onTitleChanged(cb: (title: string) => void): void;
}

export interface TabState {
  id: number;
  title: string;
}

export interface TabsSnapshot {
  tabs: TabState[];
  activeId: number | null;
}

interface TabEntry {
  id: number;
  title: string;
  view: TabViewHandle;
}

/**
 * Owns the ordered list of editor tabs. Pure logic — Electron's
 * WebContentsView is injected via `createView` so this is unit-testable.
 */
export class TabManager {
  private tabs: TabEntry[] = [];
  private activeId: number | null = null;
  private nextId = 1;
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
    const entry: TabEntry = { id, title: "New Tab", view };
    view.onTitleChanged((title) => {
      entry.title = title;
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
    closed.view.destroy();
    if (this.tabs.length === 0) {
      this.activeId = null;
      this.newTab(); // newTab emits
      return;
    }
    if (this.activeId === id) {
      const neighbor = this.tabs[Math.max(0, idx - 1)];
      this.setActive(neighbor.id);
    } else {
      this.emit();
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
    };
  }

  layout(content: { width: number; height: number }, tabbarHeight: number): void {
    this.lastLayout = { content, tabbarHeight };
    for (const tab of this.tabs) this.applyLayout(tab);
  }

  count(): number {
    return this.tabs.length;
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
