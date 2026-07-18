# pen-editor-desktop Electron Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A thin Electron wrapper for pen-editor: one window, an Electron-drawn tab bar where each tab is an independent `WebContentsView` loading the deployed editor URL, native menus/hotkeys forwarded to the editor's command palette ids, web/PWA untouched.

**Architecture:** Main process owns a `BaseWindow` with a tab-bar `WebContentsView` (local HTML) on top and one `WebContentsView` per tab below, all loading `https://pen-editor.onrender.com` (overridable via `PEN_DESKTOP_URL`). Menu commands go over IPC channel `menu:command` to the active tab; a sandboxed preload exposes `window.penDesktop.onMenuCommand`, and a tiny bridge module in the pen-editor repo dispatches command ids into the existing command-palette registry (`getCommands()` from `src/lib/commands/registry.ts`).

**Tech Stack:** Electron (latest, ≥ 35 — needs `BaseWindow`/`WebContentsView`), TypeScript (strict, CommonJS output — sandboxed preloads must be CJS), electron-builder (mac dmg+zip), Vitest (unit), @playwright/test `_electron` (smoke).

## Global Constraints

- Repo: `/Users/daniilrozhkov/prj/pen-editor-app/pen-editor-desktop` (independent git repo, already initialized, spec committed).
- Default editor URL: `https://pen-editor.onrender.com`; env override `PEN_DESKTOP_URL` (dev: `http://localhost:5173`).
- All editor views: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Preload is the only bridge.
- Whole package is CommonJS (`"type": "commonjs"` implicit; tsc `module: commonjs`) — no `.js` import-extension rule here (that rule is backend-only).
- In-tab navigation clamped to the editor origin; other http(s) origins open via `shell.openExternal`.
- Cross-repo contract: menu command ids are pen-editor `PaletteCommand.id` values (`file-open`, `file-export-pen`, `file-export-json`, `file-export-tokens`, `file-import-tokens`). Any change must update both repos' CLAUDE.md.
- Tab bar height: 38 px constant `TABBAR_HEIGHT`.
- No auto-updater, no code signing, macOS only (v1).
- Commit after every task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- pen-editor changes (Task 7) happen in `/Users/daniilrozhkov/prj/pen-editor-app/pen-editor` (separate repo, separate commit; its CI must stay green: `npm run lint && npm test && npm run build`).

## File Structure (desktop repo)

```
package.json               # scripts, deps, electron-builder "build" config (Task 1, 8)
tsconfig.json              # strict CJS build src/ → dist/ (Task 1)
vitest.config.ts           # unit tests in test/ (Task 1)
playwright.config.ts       # e2e/ (Task 6)
src/main/index.ts          # app entry (Task 1, wired fully in Task 5)
src/main/config.ts         # resolveEditorUrl() (Task 1)
src/main/tabManager.ts     # TabManager + TabViewHandle interface (Task 2)
src/main/menu.ts           # buildMenuTemplate(actions, opts) (Task 3)
src/main/navigation.ts     # decideNavigation() + attachNavigationPolicy() (Task 4)
src/main/window.ts         # createMainWindow(): views, IPC, layout (Task 5)
src/preload/tab.ts         # window.penDesktop bridge (Task 5)
src/preload/tabbar.ts      # window.penTabbar bridge (Task 5)
src/tabbar/tabbar.html     # tab strip UI (Task 5)
src/tabbar/tabbar.css      # (Task 5)
src/tabbar/renderer.ts     # renders tabs from penTabbar state (Task 5)
assets/offline.html        # offline fallback page (Task 4)
test/*.test.ts             # Vitest unit tests (Tasks 1-4)
e2e/smoke.spec.ts          # Playwright _electron smoke (Task 6)
CLAUDE.md                  # repo guide + cross-repo contract (Task 8)
```

The tab bar and offline page are plain static files copied to `dist/` by a `copy-static` script step (tsc only emits JS).

---

### Task 1: Scaffold + config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/main/config.ts`, `src/main/index.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `resolveEditorUrl(env: NodeJS.ProcessEnv): string` — returns `PEN_DESKTOP_URL` if set and parseable as http(s) URL, else `https://pen-editor.onrender.com`. Also `DEFAULT_EDITOR_URL` const export.

- [ ] **Step 1: Init npm package and deps**

```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-desktop
npm init -y
npm i -D electron electron-builder typescript vitest @types/node
```

- [ ] **Step 2: Write configs**

`package.json` — edit the generated file to have (keep the dep versions npm picked):

```json
{
  "name": "pen-editor-desktop",
  "version": "0.1.0",
  "description": "Desktop (Electron) shell for pen-editor",
  "main": "dist/main/index.js",
  "private": true,
  "scripts": {
    "build:ts": "tsc",
    "copy-static": "mkdir -p dist/tabbar dist/assets && cp src/tabbar/tabbar.html src/tabbar/tabbar.css dist/tabbar/ && cp assets/offline.html dist/assets/",
    "build": "npm run build:ts && npm run copy-static",
    "start": "npm run build && electron .",
    "dev": "PEN_DESKTOP_URL=http://localhost:5173 npm run start",
    "lint": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022", "DOM"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

(`"lib": ["DOM"]` is needed because `src/tabbar/renderer.ts` and the preloads reference DOM/window types; main-process files must not use DOM globals.)

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

`.gitignore`:

```
node_modules/
dist/
release/
test-results/
```

- [ ] **Step 3: Write the failing test**

`test/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveEditorUrl, DEFAULT_EDITOR_URL } from "../src/main/config";

describe("resolveEditorUrl", () => {
  it("defaults to the production URL", () => {
    expect(resolveEditorUrl({})).toBe(DEFAULT_EDITOR_URL);
    expect(DEFAULT_EDITOR_URL).toBe("https://pen-editor.onrender.com");
  });

  it("honors PEN_DESKTOP_URL", () => {
    expect(resolveEditorUrl({ PEN_DESKTOP_URL: "http://localhost:5173" })).toBe(
      "http://localhost:5173",
    );
  });

  it("ignores a non-http(s) or unparseable override", () => {
    expect(resolveEditorUrl({ PEN_DESKTOP_URL: "file:///etc/passwd" })).toBe(DEFAULT_EDITOR_URL);
    expect(resolveEditorUrl({ PEN_DESKTOP_URL: "not a url" })).toBe(DEFAULT_EDITOR_URL);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL (cannot resolve `../src/main/config`)

- [ ] **Step 5: Implement config**

`src/main/config.ts`:

```ts
export const DEFAULT_EDITOR_URL = "https://pen-editor.onrender.com";

/** Editor URL: PEN_DESKTOP_URL override (http/https only), else production. */
export function resolveEditorUrl(env: NodeJS.ProcessEnv): string {
  const override = env.PEN_DESKTOP_URL;
  if (override) {
    try {
      const url = new URL(override);
      if (url.protocol === "http:" || url.protocol === "https:") return override;
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_EDITOR_URL;
}
```

- [ ] **Step 6: Minimal app entry (placeholder window, replaced in Task 5)**

`src/main/index.ts`:

```ts
import { app, BrowserWindow } from "electron";
import { resolveEditorUrl } from "./config";

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 900 });
  void win.loadURL(resolveEditorUrl(process.env));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 7: Verify test passes and build compiles**

Run: `npx vitest run test/config.test.ts` → PASS
Run: `npm run build` → exits 0 (copy-static will fail until the static files exist — for this task change nothing; if `copy-static` errors, temporarily guard it: `"copy-static": "mkdir -p dist/tabbar dist/assets && (cp src/tabbar/tabbar.html src/tabbar/tabbar.css dist/tabbar/ 2>/dev/null; cp assets/offline.html dist/assets/ 2>/dev/null); true"` — Task 5 makes the files real; keep the guard, it stays harmless.)

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: scaffold Electron shell with url config

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: TabManager

**Files:**
- Create: `src/main/tabManager.ts`
- Test: `test/tabManager.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TabViewHandle {
  loadURL(url: string): void;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setVisible(visible: boolean): void;
  destroy(): void;
  sendMenuCommand(commandId: string): void;
  focus(): void;
  /** Register title-change callback; handle impl calls it with the new title. */
  onTitleChanged(cb: (title: string) => void): void;
}
export interface TabState { id: number; title: string }
export interface TabsSnapshot { tabs: TabState[]; activeId: number | null }
export class TabManager {
  constructor(opts: {
    createView: () => TabViewHandle;
    editorUrl: string;
    onStateChanged: (s: TabsSnapshot) => void;
  });
  newTab(): number;                 // creates+loads+activates, returns id
  closeTab(id: number): void;       // destroys; activates neighbor; if last tab closed, opens a fresh one
  activate(id: number): void;
  nextTab(): void;                  // cycles
  prevTab(): void;
  activeHandle(): TabViewHandle | null;
  getSnapshot(): TabsSnapshot;
  layout(content: { width: number; height: number }, tabbarHeight: number): void;
  count(): number;
}
```

- Consumes: nothing from other tasks (pure; Electron injected via `createView`).

- [ ] **Step 1: Write the failing tests**

`test/tabManager.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TabManager, type TabViewHandle, type TabsSnapshot } from "../src/main/tabManager";

function makeFakeView() {
  let titleCb: ((t: string) => void) | undefined;
  const view = {
    loadURL: vi.fn(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    destroy: vi.fn(),
    sendMenuCommand: vi.fn(),
    focus: vi.fn(),
    onTitleChanged: vi.fn((cb: (t: string) => void) => {
      titleCb = cb;
    }),
    emitTitle: (t: string) => titleCb?.(t),
  };
  return view as TabViewHandle & { emitTitle: (t: string) => void; loadURL: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn>; setBounds: ReturnType<typeof vi.fn> };
}

describe("TabManager", () => {
  let views: ReturnType<typeof makeFakeView>[];
  let states: TabsSnapshot[];
  let tm: TabManager;

  beforeEach(() => {
    views = [];
    states = [];
    tm = new TabManager({
      createView: () => {
        const v = makeFakeView();
        views.push(v);
        return v;
      },
      editorUrl: "https://pen-editor.onrender.com",
      onStateChanged: (s) => states.push(s),
    });
  });

  it("newTab loads the editor url and becomes active", () => {
    const id = tm.newTab();
    expect(views[0].loadURL).toHaveBeenCalledWith("https://pen-editor.onrender.com");
    expect(tm.getSnapshot().activeId).toBe(id);
    expect(tm.count()).toBe(1);
  });

  it("second tab hides the first and shows itself", () => {
    tm.newTab();
    tm.newTab();
    expect(views[0].setVisible).toHaveBeenLastCalledWith(false);
    expect(views[1].setVisible).toHaveBeenLastCalledWith(true);
  });

  it("activate switches visibility and focuses", () => {
    const a = tm.newTab();
    tm.newTab();
    tm.activate(a);
    expect(views[0].setVisible).toHaveBeenLastCalledWith(true);
    expect(views[1].setVisible).toHaveBeenLastCalledWith(false);
    expect(tm.getSnapshot().activeId).toBe(a);
  });

  it("closeTab destroys the view and activates a neighbor", () => {
    const a = tm.newTab();
    const b = tm.newTab();
    tm.closeTab(b);
    expect(views[1].destroy).toHaveBeenCalled();
    expect(tm.getSnapshot().activeId).toBe(a);
    expect(tm.count()).toBe(1);
  });

  it("closing the last tab opens a fresh one", () => {
    const a = tm.newTab();
    tm.closeTab(a);
    expect(tm.count()).toBe(1);
    expect(tm.getSnapshot().activeId).not.toBe(a);
  });

  it("next/prev cycle through tabs", () => {
    const a = tm.newTab();
    const b = tm.newTab();
    const c = tm.newTab();
    expect(tm.getSnapshot().activeId).toBe(c);
    tm.nextTab();
    expect(tm.getSnapshot().activeId).toBe(a);
    tm.prevTab();
    expect(tm.getSnapshot().activeId).toBe(c);
    tm.prevTab();
    expect(tm.getSnapshot().activeId).toBe(b);
  });

  it("title changes flow into the snapshot and notify", () => {
    tm.newTab();
    views[0].emitTitle("My Design — Pen");
    const last = states[states.length - 1];
    expect(last.tabs[0].title).toBe("My Design — Pen");
  });

  it("layout positions all tab views below the tab bar", () => {
    tm.newTab();
    tm.newTab();
    tm.layout({ width: 1200, height: 800 }, 38);
    for (const v of views) {
      expect(v.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 38, width: 1200, height: 762 });
    }
  });

  it("every mutation emits a fresh snapshot", () => {
    tm.newTab();
    const before = states.length;
    tm.newTab();
    tm.nextTab();
    expect(states.length).toBeGreaterThan(before + 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tabManager.test.ts` — FAIL (module not found)

- [ ] **Step 3: Implement**

`src/main/tabManager.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tabManager.test.ts` — PASS. Also `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: tab manager with injected view factory

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Menu template

**Files:**
- Create: `src/main/menu.ts`
- Test: `test/menu.test.ts`

**Interfaces:**
- Produces:

```ts
export interface MenuActions {
  newTab(): void;
  closeTab(): void;   // closes the ACTIVE tab
  nextTab(): void;
  prevTab(): void;
  forwardToActiveTab(commandId: string): void; // sends menu:command to active tab
}
export function buildMenuTemplate(actions: MenuActions, opts: { isMac: boolean }): Electron.MenuItemConstructorOptions[];
```

- Consumes: command ids from the Global Constraints contract (`file-open`, `file-export-pen`, `file-export-json`, `file-export-tokens`, `file-import-tokens`).
- Note: import Electron types with `import type { MenuItemConstructorOptions } from "electron"` — type-only, so tests run in plain Node without the Electron binary.

- [ ] **Step 1: Write the failing tests**

`test/menu.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMenuTemplate, type MenuActions } from "../src/main/menu";
import type { MenuItemConstructorOptions } from "electron";

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...flatten((i.submenu as MenuItemConstructorOptions[]) ?? [])]);
}

describe("buildMenuTemplate", () => {
  let actions: MenuActions;

  beforeEach(() => {
    actions = {
      newTab: vi.fn(),
      closeTab: vi.fn(),
      nextTab: vi.fn(),
      prevTab: vi.fn(),
      forwardToActiveTab: vi.fn(),
    };
  });

  function item(label: string): MenuItemConstructorOptions {
    const found = flatten(buildMenuTemplate(actions, { isMac: true })).find((i) => i.label === label);
    if (!found) throw new Error(`menu item not found: ${label}`);
    return found;
  }

  it("has the app menu first on mac only", () => {
    expect(buildMenuTemplate(actions, { isMac: true })[0].role).toBe("appMenu");
    expect(buildMenuTemplate(actions, { isMac: false })[0].label).toBe("File");
  });

  it("New Tab triggers newTab with CmdOrCtrl+T", () => {
    const i = item("New Tab");
    expect(i.accelerator).toBe("CmdOrCtrl+T");
    (i.click as () => void)();
    expect(actions.newTab).toHaveBeenCalled();
  });

  it("Close Tab triggers closeTab with CmdOrCtrl+W", () => {
    const i = item("Close Tab");
    expect(i.accelerator).toBe("CmdOrCtrl+W");
    (i.click as () => void)();
    expect(actions.closeTab).toHaveBeenCalled();
  });

  it.each([
    ["Open…", "CmdOrCtrl+O", "file-open"],
    ["Save as .pen", "CmdOrCtrl+S", "file-export-pen"],
    ["Export as .json", "Shift+CmdOrCtrl+S", "file-export-json"],
    ["Export Design Tokens…", undefined, "file-export-tokens"],
    ["Import Design Tokens…", undefined, "file-import-tokens"],
  ])("%s forwards %s", (label, accelerator, commandId) => {
    const i = item(label as string);
    expect(i.accelerator).toBe(accelerator);
    (i.click as () => void)();
    expect(actions.forwardToActiveTab).toHaveBeenCalledWith(commandId);
  });

  it("tab cycling shortcuts exist", () => {
    expect(item("Next Tab").accelerator).toBe("Ctrl+Tab");
    expect(item("Previous Tab").accelerator).toBe("Ctrl+Shift+Tab");
  });

  it("Edit menu uses native roles (undo/redo/cut/copy/paste/selectAll)", () => {
    const roles = flatten(buildMenuTemplate(actions, { isMac: true })).map((i) => i.role);
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
      expect(roles).toContain(role);
    }
  });

  it("View menu has zoom, fullscreen and devtools roles", () => {
    const roles = flatten(buildMenuTemplate(actions, { isMac: true })).map((i) => i.role);
    for (const role of ["resetZoom", "zoomIn", "zoomOut", "togglefullscreen", "toggleDevTools", "reload"]) {
      expect(roles).toContain(role);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/menu.test.ts` — FAIL

- [ ] **Step 3: Implement**

`src/main/menu.ts`:

```ts
import type { MenuItemConstructorOptions } from "electron";

export interface MenuActions {
  newTab(): void;
  closeTab(): void;
  nextTab(): void;
  prevTab(): void;
  forwardToActiveTab(commandId: string): void;
}

/**
 * Application menu. File actions forward pen-editor command-palette ids over
 * IPC (the cross-repo contract — see CLAUDE.md); Edit/View use native roles
 * so text fields and zoom behave like any mac app.
 */
export function buildMenuTemplate(
  actions: MenuActions,
  opts: { isMac: boolean },
): MenuItemConstructorOptions[] {
  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => actions.newTab() },
      {
        label: "Open…",
        accelerator: "CmdOrCtrl+O",
        click: () => actions.forwardToActiveTab("file-open"),
      },
      { type: "separator" },
      {
        label: "Save as .pen",
        accelerator: "CmdOrCtrl+S",
        click: () => actions.forwardToActiveTab("file-export-pen"),
      },
      {
        label: "Export as .json",
        accelerator: "Shift+CmdOrCtrl+S",
        click: () => actions.forwardToActiveTab("file-export-json"),
      },
      { label: "Export Design Tokens…", click: () => actions.forwardToActiveTab("file-export-tokens") },
      { label: "Import Design Tokens…", click: () => actions.forwardToActiveTab("file-import-tokens") },
      { type: "separator" },
      { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => actions.closeTab() },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { role: "reload" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      { role: "toggleDevTools" },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { type: "separator" },
      { label: "Next Tab", accelerator: "Ctrl+Tab", click: () => actions.nextTab() },
      { label: "Previous Tab", accelerator: "Ctrl+Shift+Tab", click: () => actions.prevTab() },
    ],
  };

  const template: MenuItemConstructorOptions[] = [fileMenu, editMenu, viewMenu, windowMenu];
  if (opts.isMac) template.unshift({ role: "appMenu" });
  return template;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/menu.test.ts` — PASS. Also `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: application menu with palette-id forwarding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Navigation policy + offline fallback page

**Files:**
- Create: `src/main/navigation.ts`, `assets/offline.html`
- Test: `test/navigation.test.ts`

**Interfaces:**
- Produces:

```ts
export type NavigationDecision = "allow" | "external" | "deny";
/** Pure policy: same-origin as editor → allow; other http(s) → external; else deny. */
export function decideNavigation(targetUrl: string, editorOrigin: string): NavigationDecision;
/** Wires will-navigate + setWindowOpenHandler on a WebContents per the policy. */
export function attachNavigationPolicy(
  contents: Electron.WebContents,
  editorOrigin: string,
  openExternal: (url: string) => void,
): void;
/** did-fail-load hook: main-frame load failures (except ERR_ABORTED -3) load the offline page. */
export function attachOfflineFallback(contents: Electron.WebContents, offlineFile: string): void;
```

- Consumes: nothing. `editorOrigin` is `new URL(resolveEditorUrl(process.env)).origin` (Task 1).
- `assets/offline.html` reads `?target=<encoded url>` and its Retry button navigates to it.

- [ ] **Step 1: Write the failing tests**

`test/navigation.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { decideNavigation, attachNavigationPolicy, attachOfflineFallback } from "../src/main/navigation";

const ORIGIN = "https://pen-editor.onrender.com";

describe("decideNavigation", () => {
  it("allows same-origin", () => {
    expect(decideNavigation(`${ORIGIN}/some/path?x=1`, ORIGIN)).toBe("allow");
  });
  it("sends other http(s) origins external", () => {
    expect(decideNavigation("https://example.com/docs", ORIGIN)).toBe("external");
    expect(decideNavigation("http://localhost:9999/", ORIGIN)).toBe("external");
  });
  it("denies non-http schemes and garbage", () => {
    expect(decideNavigation("file:///etc/passwd", ORIGIN)).toBe("deny");
    expect(decideNavigation("javascript:alert(1)", ORIGIN)).toBe("deny");
    expect(decideNavigation("%%%", ORIGIN)).toBe("deny");
  });
});

type Handler = (...args: unknown[]) => void;

function fakeContents() {
  const handlers = new Map<string, Handler>();
  let openHandler: ((details: { url: string }) => { action: string }) | undefined;
  return {
    on: vi.fn((event: string, cb: Handler) => handlers.set(event, cb)),
    setWindowOpenHandler: vi.fn((cb: (details: { url: string }) => { action: string }) => {
      openHandler = cb;
    }),
    loadFile: vi.fn(),
    getURL: vi.fn(() => `${ORIGIN}/`),
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args);
    },
    open(url: string) {
      return openHandler!({ url });
    },
  };
}

describe("attachNavigationPolicy", () => {
  it("prevents will-navigate to foreign origins and opens externally", () => {
    const contents = fakeContents();
    const openExternal = vi.fn();
    attachNavigationPolicy(contents as never, ORIGIN, openExternal);
    const ev = { preventDefault: vi.fn() };
    contents.emit("will-navigate", ev, "https://example.com/x");
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://example.com/x");
  });

  it("lets same-origin will-navigate through", () => {
    const contents = fakeContents();
    const openExternal = vi.fn();
    attachNavigationPolicy(contents as never, ORIGIN, openExternal);
    const ev = { preventDefault: vi.fn() };
    contents.emit("will-navigate", ev, `${ORIGIN}/inner`);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("window.open goes external for http(s), denied otherwise, same-origin denied in-window", () => {
    const contents = fakeContents();
    const openExternal = vi.fn();
    attachNavigationPolicy(contents as never, ORIGIN, openExternal);
    expect(contents.open("https://example.com/x")).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/x");
    openExternal.mockClear();
    expect(contents.open("javascript:alert(1)")).toEqual({ action: "deny" });
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("attachOfflineFallback", () => {
  it("loads the offline page on main-frame failure, with the failed url as target", () => {
    const contents = fakeContents();
    attachOfflineFallback(contents as never, "/app/dist/assets/offline.html");
    contents.emit("did-fail-load", {}, -106, "ERR_INTERNET_DISCONNECTED", `${ORIGIN}/`, true);
    expect(contents.loadFile).toHaveBeenCalledWith("/app/dist/assets/offline.html", {
      query: { target: `${ORIGIN}/` },
    });
  });

  it("ignores subframe failures and ERR_ABORTED", () => {
    const contents = fakeContents();
    attachOfflineFallback(contents as never, "/x/offline.html");
    contents.emit("did-fail-load", {}, -106, "x", `${ORIGIN}/`, false);
    contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", `${ORIGIN}/`, true);
    expect(contents.loadFile).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/navigation.test.ts` — FAIL

- [ ] **Step 3: Implement**

`src/main/navigation.ts`:

```ts
import type { WebContents } from "electron";

export type NavigationDecision = "allow" | "external" | "deny";

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

export function attachOfflineFallback(contents: WebContents, offlineFile: string): void {
  contents.on(
    "did-fail-load",
    (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ERR_ABORTED */) return;
      void contents.loadFile(offlineFile, { query: { target: validatedURL } });
    },
  );
}
```

`assets/offline.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Pen — offline</title>
    <style>
      html { color-scheme: dark; }
      body {
        margin: 0; height: 100vh; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 16px;
        background: #111; color: #ddd;
        font: 14px -apple-system, BlinkMacSystemFont, sans-serif;
      }
      button {
        padding: 8px 20px; border-radius: 8px; border: 1px solid #444;
        background: #222; color: #eee; font: inherit; cursor: pointer;
      }
      button:hover { background: #2c2c2c; }
    </style>
  </head>
  <body>
    <h1 style="font-size: 18px; margin: 0">Can’t reach Pen Editor</h1>
    <p style="margin: 0; color: #888">Check your connection, then retry.</p>
    <button id="retry">Retry</button>
    <script>
      document.getElementById("retry").addEventListener("click", () => {
        const target = new URLSearchParams(location.search).get("target");
        if (target) location.href = target;
      });
    </script>
  </body>
</html>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/navigation.test.ts` — PASS. Also `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: navigation clamp and offline fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Window assembly — views, preloads, tab bar UI, IPC

This task has no meaningful unit tests (it is Electron wiring); it is verified by `npm start` behavior and locked in by the Task 6 smoke test. Keep every pure decision OUT of this file (they already live in Tasks 2-4).

**Files:**
- Create: `src/main/window.ts`, `src/preload/tab.ts`, `src/preload/tabbar.ts`, `src/tabbar/tabbar.html`, `src/tabbar/tabbar.css`, `src/tabbar/renderer.ts`
- Modify: `src/main/index.ts` (replace placeholder), `package.json` (`copy-static` now real, remove the `true` guard if it was added)

**Interfaces:**
- Consumes: `TabManager`/`TabViewHandle` (Task 2), `buildMenuTemplate`/`MenuActions` (Task 3), `attachNavigationPolicy`/`attachOfflineFallback` (Task 4), `resolveEditorUrl` (Task 1).
- Produces IPC contract (also used by Task 6 and pen-editor Task 7):
  - `menu:command` main→tab: `(commandId: string)`
  - `tabbar:state` main→tabbar: `(s: TabsSnapshot)`
  - `tabbar:new` tabbar→main: `()`
  - `tabbar:activate` tabbar→main: `(id: number)`
  - `tabbar:close` tabbar→main: `(id: number)`
  - Renderer globals: `window.penDesktop = { onMenuCommand(cb: (id: string) => void): () => void }` (tabs); `window.penTabbar = { newTab(): void; activateTab(id: number): void; closeTab(id: number): void; onState(cb: (s: TabsSnapshot) => void): void }` (tab bar).

- [ ] **Step 1: Preload for editor tabs**

`src/preload/tab.ts`:

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const api = {
  onMenuCommand(cb: (commandId: string) => void): () => void {
    const listener = (_e: IpcRendererEvent, commandId: string) => cb(commandId);
    ipcRenderer.on("menu:command", listener);
    return () => ipcRenderer.removeListener("menu:command", listener);
  },
};

contextBridge.exposeInMainWorld("penDesktop", api);
```

- [ ] **Step 2: Preload for the tab bar**

`src/preload/tabbar.ts`:

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { TabsSnapshot } from "../main/tabManager";

const api = {
  newTab: () => ipcRenderer.send("tabbar:new"),
  activateTab: (id: number) => ipcRenderer.send("tabbar:activate", id),
  closeTab: (id: number) => ipcRenderer.send("tabbar:close", id),
  onState: (cb: (s: TabsSnapshot) => void) => {
    ipcRenderer.on("tabbar:state", (_e: IpcRendererEvent, s: TabsSnapshot) => cb(s));
  },
};

contextBridge.exposeInMainWorld("penTabbar", api);
```

- [ ] **Step 3: Tab bar UI**

`src/tabbar/tabbar.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'self'; script-src 'self'"
    />
    <link rel="stylesheet" href="tabbar.css" />
  </head>
  <body>
    <div id="tabs"></div>
    <button id="new-tab" title="New Tab (⌘T)">+</button>
    <script src="renderer.js"></script>
  </body>
</html>
```

`src/tabbar/tabbar.css`:

```css
html { color-scheme: dark; }
body {
  margin: 0;
  height: 38px;
  display: flex;
  align-items: stretch;
  background: #111;
  color: #bbb;
  font: 12px -apple-system, BlinkMacSystemFont, sans-serif;
  user-select: none;
  overflow: hidden;
}
#tabs { display: flex; align-items: stretch; overflow: hidden; flex: 1; }
.tab {
  display: flex; align-items: center; gap: 6px;
  padding: 0 10px 0 14px; max-width: 200px; min-width: 60px;
  border-right: 1px solid #1e1e1e; cursor: default; white-space: nowrap;
}
.tab .title { overflow: hidden; text-overflow: ellipsis; flex: 1; }
.tab.active { background: #1d1d1d; color: #eee; }
.tab .close {
  border: 0; background: none; color: inherit; font: inherit;
  cursor: pointer; padding: 2px 5px; border-radius: 4px; visibility: hidden;
}
.tab:hover .close, .tab.active .close { visibility: visible; }
.tab .close:hover { background: #333; }
#new-tab {
  border: 0; background: none; color: #bbb; font: 16px -apple-system, sans-serif;
  width: 38px; cursor: pointer;
}
#new-tab:hover { color: #eee; background: #1d1d1d; }
```

`src/tabbar/renderer.ts` (compiled by tsc to `dist/tabbar/renderer.js`; the DOM lib is enabled repo-wide):

```ts
import type { TabsSnapshot } from "../main/tabManager";

interface PenTabbarApi {
  newTab(): void;
  activateTab(id: number): void;
  closeTab(id: number): void;
  onState(cb: (s: TabsSnapshot) => void): void;
}

declare global {
  interface Window {
    penTabbar: PenTabbarApi;
  }
}

const tabsEl = document.getElementById("tabs")!;
document.getElementById("new-tab")!.addEventListener("click", () => window.penTabbar.newTab());

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
    close.textContent = "×";
    close.title = "Close Tab";
    close.addEventListener("mousedown", (e) => e.stopPropagation());
    close.addEventListener("click", () => window.penTabbar.closeTab(tab.id));
    el.appendChild(close);

    tabsEl.appendChild(el);
  }
});

export {};
```

Note: `renderer.ts` imports only a *type* from `../main/tabManager`, so tsc emits no `require` — but tsc will still emit `"use strict"; Object.defineProperty(exports, ...)` for the `export {}` marker in CJS mode, and `exports` doesn't exist in a plain `<script>`. Fix: remove `export {}` and instead avoid top-level name collisions (the file has none that matter), OR wrap: simplest is to drop `export {}` and add `// eslint-disable-next-line` nothing — with `"module": "commonjs"` a file WITH only type imports and no exports compiles to plain script statements. Verify `dist/tabbar/renderer.js` contains no `exports`/`require` references after `npm run build`; if it does, replace the type import with an inline `type TabsSnapshot = { tabs: { id: number; title: string }[]; activeId: number | null }` and delete both the import and `export {}`.

- [ ] **Step 4: Window assembly**

`src/main/window.ts`:

```ts
import path from "node:path";
import { BaseWindow, WebContentsView, Menu, ipcMain, shell } from "electron";
import { TabManager, type TabViewHandle, type TabsSnapshot } from "./tabManager";
import { buildMenuTemplate } from "./menu";
import { attachNavigationPolicy, attachOfflineFallback } from "./navigation";

export const TABBAR_HEIGHT = 38;

/**
 * One app window: a tab-bar WebContentsView on top, one WebContentsView per
 * editor tab below. All policy/tab logic lives in tabManager/menu/navigation;
 * this file only wires Electron objects together.
 */
export function createMainWindow(editorUrl: string): BaseWindow {
  const editorOrigin = new URL(editorUrl).origin;
  const offlineFile = path.join(__dirname, "../assets/offline.html");

  const win = new BaseWindow({ width: 1440, height: 900, title: "Pen Editor" });

  // --- tab bar view ---
  const tabbarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/tabbar.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(tabbarView);
  void tabbarView.webContents.loadFile(path.join(__dirname, "../tabbar/tabbar.html"));

  const pushState = (s: TabsSnapshot) => tabbarView.webContents.send("tabbar:state", s);

  // --- tabs ---
  const tabs = new TabManager({
    editorUrl,
    onStateChanged: pushState,
    createView: (): TabViewHandle => {
      const view = new WebContentsView({
        webPreferences: {
          preload: path.join(__dirname, "../preload/tab.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      attachNavigationPolicy(view.webContents, editorOrigin, (url) => void shell.openExternal(url));
      attachOfflineFallback(view.webContents, offlineFile);
      win.contentView.addChildView(view);
      return {
        loadURL: (url) => void view.webContents.loadURL(url),
        setBounds: (b) => view.setBounds(b),
        setVisible: (v) => view.setVisible(v),
        destroy: () => {
          win.contentView.removeChildView(view);
          view.webContents.close();
        },
        sendMenuCommand: (id) => view.webContents.send("menu:command", id),
        focus: () => view.webContents.focus(),
        onTitleChanged: (cb) =>
          view.webContents.on("page-title-updated", (_e, title) => cb(title)),
      };
    },
  });

  // --- layout ---
  const layout = () => {
    const { width, height } = win.getContentBounds();
    tabbarView.setBounds({ x: 0, y: 0, width, height: TABBAR_HEIGHT });
    tabs.layout({ width, height }, TABBAR_HEIGHT);
  };
  win.on("resize", layout);
  layout();

  // --- tab bar IPC (scoped to this window's tabbar webContents) ---
  const tabbarId = tabbarView.webContents.id;
  const fromOurTabbar = (event: Electron.IpcMainEvent) => event.sender.id === tabbarId;
  ipcMain.on("tabbar:new", (e) => fromOurTabbar(e) && tabs.newTab());
  ipcMain.on("tabbar:activate", (e, id: number) => fromOurTabbar(e) && tabs.activate(id));
  ipcMain.on("tabbar:close", (e, id: number) => fromOurTabbar(e) && tabs.closeTab(id));
  // Re-send current state when the tab bar (re)loads — it may have missed
  // snapshots emitted before its DOM was ready.
  tabbarView.webContents.on("did-finish-load", () => pushState(tabs.getSnapshot()));

  // --- menu ---
  const menu = Menu.buildFromTemplate(
    buildMenuTemplate(
      {
        newTab: () => tabs.newTab(),
        closeTab: () => {
          const active = tabs.getSnapshot().activeId;
          if (active !== null) tabs.closeTab(active);
        },
        nextTab: () => tabs.nextTab(),
        prevTab: () => tabs.prevTab(),
        forwardToActiveTab: (commandId) => tabs.activeHandle()?.sendMenuCommand(commandId),
      },
      { isMac: process.platform === "darwin" },
    ),
  );
  Menu.setApplicationMenu(menu);

  tabs.newTab();
  return win;
}
```

- [ ] **Step 5: Replace the entry point**

`src/main/index.ts`:

```ts
import { app } from "electron";
import { resolveEditorUrl } from "./config";
import { createMainWindow } from "./window";

const editorUrl = resolveEditorUrl(process.env);

app.whenReady().then(() => {
  createMainWindow(editorUrl);

  app.on("activate", () => {
    const { BaseWindow } = require("electron") as typeof import("electron");
    if (BaseWindow.getAllWindows().length === 0) createMainWindow(editorUrl);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

(Use a plain top-of-file `import { app, BaseWindow } from "electron"` instead of the inline require if lint prefers — both are fine in CJS.)

- [ ] **Step 6: Verify build + manual launch**

Run: `npm run build` → 0 errors; check `dist/tabbar/renderer.js` has no `exports`/`require` (see Step 3 note).
Run: `PEN_DESKTOP_URL=https://pen-editor.onrender.com npm start` (or against local dev server) — expect: window with dark tab bar, one tab loading the editor, ⌘T opens a second tab, tab bar shows both, clicking switches, × closes, ⌘W closes active, closing last tab respawns one. Quit with ⌘Q. If no display/network is available in the execution environment, note it and rely on Task 6.
Run: `npx vitest run` — all suites still PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: window assembly with tab bar, preload bridges and menus

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Playwright-Electron smoke test

**Files:**
- Create: `playwright.config.ts`, `e2e/smoke.spec.ts`
- Modify: `package.json` (add script + dep)

**Interfaces:**
- Consumes: the whole app via `_electron.launch` with `PEN_DESKTOP_URL` pointed at an in-test stub HTTP server; IPC/window globals from Task 5 (`window.penDesktop`).

- [ ] **Step 1: Install and configure**

```bash
npm i -D @playwright/test
```

`playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  // Electron tests must not run in parallel against the same built output.
  workers: 1,
});
```

`package.json` scripts, add:

```json
"test:e2e": "npm run build && playwright test"
```

- [ ] **Step 2: Write the smoke test**

`e2e/smoke.spec.ts`:

```ts
import { test, expect, _electron as electron } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

let server: http.Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Stub Editor</title>
      <h1 id="ready">stub-editor</h1>
      <script>
        window.__commands = [];
        if (window.penDesktop) {
          window.penDesktop.onMenuCommand((id) => window.__commands.push(id));
        }
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test("launches, opens a tab with the editor, exposes the menu bridge", async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PEN_DESKTOP_URL: baseUrl },
  });

  // Windows: the tab bar view and the first tab view each surface as a page.
  const editorPage = await app.waitForEvent("window", {
    predicate: (p) => p.url().startsWith(baseUrl),
  });
  await expect(editorPage.locator("#ready")).toHaveText("stub-editor");

  // The preload bridge is present in the editor page.
  expect(await editorPage.evaluate(() => typeof (window as never as { penDesktop?: unknown }).penDesktop)).toBe(
    "object",
  );

  // Forward a menu command from the main process to the active tab and see it arrive.
  await app.evaluate(({ webContents }, url) => {
    const target = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(url));
    target?.send("menu:command", "file-open");
  }, baseUrl);
  await expect
    .poll(() => editorPage.evaluate(() => (window as never as { __commands: string[] }).__commands))
    .toContain("file-open");

  await app.close();
});
```

- [ ] **Step 3: Run it**

Run: `npm run test:e2e`
Expected: PASS (1 test). If the runner machine cannot open windows, run headful is still fine on macOS locally; report if blocked.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: playwright-electron smoke against a stub editor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: pen-editor bridge module (SEPARATE REPO)

Work in `/Users/daniilrozhkov/prj/pen-editor-app/pen-editor` (own git repo; keep its CI green).

**Files:**
- Create: `src/lib/desktopBridge.ts`
- Modify: `src/main.tsx` (one call at startup)
- Test: `src/lib/__tests__/desktopBridge.test.ts`
- Modify: `CLAUDE.md` (document the contract — see Step 6)

**Interfaces:**
- Consumes: `window.penDesktop` global injected by the desktop preload: `{ onMenuCommand(cb: (commandId: string) => void): () => void }`; `getCommands()` from `@/lib/commands/registry` (existing).
- Produces: `initDesktopBridge(): () => void` — no-op returning `() => {}` on the web.

- [ ] **Step 1: Write the failing test**

`src/lib/__tests__/desktopBridge.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initDesktopBridge } from "@/lib/desktopBridge";
import * as registry from "@/lib/commands/registry";

describe("initDesktopBridge", () => {
  afterEach(() => {
    delete (window as { penDesktop?: unknown }).penDesktop;
    vi.restoreAllMocks();
  });

  it("is a no-op on the web (no window.penDesktop)", () => {
    expect(() => initDesktopBridge()()).not.toThrow();
  });

  it("subscribes and dispatches command ids through the palette registry", () => {
    let handler: ((id: string) => void) | undefined;
    const unsubscribe = vi.fn();
    (window as { penDesktop?: unknown }).penDesktop = {
      onMenuCommand: (cb: (id: string) => void) => {
        handler = cb;
        return unsubscribe;
      },
    };
    const run = vi.fn();
    vi.spyOn(registry, "getCommands").mockReturnValue([
      { id: "file-open", label: "Open…", group: "File", run },
    ]);

    const dispose = initDesktopBridge();
    handler!("file-open");
    expect(run).toHaveBeenCalledTimes(1);

    dispose();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("warns and survives an unknown command id", () => {
    let handler: ((id: string) => void) | undefined;
    (window as { penDesktop?: unknown }).penDesktop = {
      onMenuCommand: (cb: (id: string) => void) => {
        handler = cb;
        return () => {};
      },
    };
    vi.spyOn(registry, "getCommands").mockReturnValue([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    initDesktopBridge();
    expect(() => handler!("no-such-command")).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor && npx vitest run src/lib/__tests__/desktopBridge.test.ts` — FAIL (module not found)

- [ ] **Step 3: Implement**

`src/lib/desktopBridge.ts`:

```ts
import { getCommands } from "@/lib/commands/registry";

/**
 * Bridge to the Electron shell (pen-editor-desktop). The desktop preload
 * exposes window.penDesktop; native menu items send command-palette ids
 * (e.g. "file-open") which we dispatch through the existing registry.
 * On the web window.penDesktop is absent and this is a no-op.
 */
export interface PenDesktopApi {
  onMenuCommand(cb: (commandId: string) => void): () => void;
}

declare global {
  interface Window {
    penDesktop?: PenDesktopApi;
  }
}

export function initDesktopBridge(): () => void {
  const api = window.penDesktop;
  if (!api) return () => {};
  return api.onMenuCommand((commandId) => {
    const command = getCommands().find((c) => c.id === commandId);
    if (command) {
      command.run();
    } else {
      console.warn(`[desktopBridge] unknown menu command id: ${commandId}`);
    }
  });
}
```

- [ ] **Step 4: Wire into startup**

In `src/main.tsx`, add near the other top-level imports and side-effect calls (before ReactDOM render is fine):

```ts
import { initDesktopBridge } from "@/lib/desktopBridge";

initDesktopBridge();
```

- [ ] **Step 5: Verify**

Run: `npx vitest run src/lib/__tests__/desktopBridge.test.ts` — PASS
Run: `npm run lint && npm test && npm run build` — all green (full suite; the build must not grow a chunk warning from this tiny module).

- [ ] **Step 6: Document the contract in pen-editor/CLAUDE.md**

Append to `CLAUDE.md` (new subsection under Architecture):

```markdown
### Desktop shell bridge

The Electron app (`../pen-editor-desktop`, its own repo) loads the deployed
editor and exposes `window.penDesktop = { onMenuCommand(cb) }` from its
preload. `src/lib/desktopBridge.ts` (called once in `main.tsx`) dispatches
received ids through the command-palette registry (`getCommands()`), so
**menu items in the desktop repo reference `PaletteCommand.id` values**
(`file-open`, `file-export-pen`, `file-export-json`, `file-export-tokens`,
`file-import-tokens`). Renaming or removing one of these ids breaks the
desktop menu — update `pen-editor-desktop/src/main/menu.ts` (and its
CLAUDE.md) in the same change. On the web `window.penDesktop` is absent and
the bridge is a no-op.
```

- [ ] **Step 7: Commit (pen-editor repo)**

```bash
git add src/lib/desktopBridge.ts src/lib/__tests__/desktopBridge.test.ts src/main.tsx CLAUDE.md
git commit -m "feat: desktop shell menu bridge (window.penDesktop → command palette)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Do NOT push yet — pushing to `main` is a release decision made at the end.

---

### Task 8: Packaging + repo docs

**Files:**
- Modify: `package.json` (electron-builder config + `dist` script)
- Create: `CLAUDE.md`, `README.md`
- Modify (parent-level, NOT a git repo): `/Users/daniilrozhkov/prj/pen-editor-app/CLAUDE.md` — mention the third repo

**Interfaces:** none new.

- [ ] **Step 1: electron-builder config**

Add to `package.json`:

```json
"build": {
  "appId": "com.peneditor.desktop",
  "productName": "Pen Editor",
  "directories": { "output": "release" },
  "files": ["dist/**"],
  "mac": { "target": ["dmg", "zip"], "category": "public.app-category.graphics-design" }
}
```

Note: `"build"` (electron-builder config) conflicts with the existing `"build"` npm *script* only in your head — they live in different keys (`scripts.build` vs top-level `build`) and coexist fine.

Add script:

```json
"dist": "npm run build && electron-builder --mac"
```

- [ ] **Step 2: Build the app**

Run: `npm run dist`
Expected: `release/Pen Editor-0.1.0-arm64.dmg` (and `.zip`) exist; build completes without signing (electron-builder skips signing when no identity — if it errors on signing, add `"mac": { ..., "identity": null }`).
Run: `open "release/mac-arm64/Pen Editor.app"` — app launches, editor loads (or offline page without network).

- [ ] **Step 3: Write CLAUDE.md**

`CLAUDE.md`:

```markdown
# CLAUDE.md — pen-editor-desktop

Thin Electron shell for pen-editor. The editor itself is NOT here — each tab
is a `WebContentsView` loading the deployed frontend
(`https://pen-editor.onrender.com`, override with `PEN_DESKTOP_URL`; `npm
run dev` points it at a local Vite dev server on :5173). The AI backend
stays remote. Design spec: `docs/superpowers/specs/2026-07-18-electron-shell-design.md`.

## Commands

```bash
npm run build     # tsc + copy static files → dist/
npm start         # build + launch Electron
npm run dev       # same, against http://localhost:5173
npm test          # Vitest unit tests (test/)
npm run test:e2e  # build + Playwright _electron smoke (stub HTTP server, no network)
npm run lint      # tsc --noEmit
npm run dist      # electron-builder → release/ (mac dmg+zip, unsigned)
```

## Architecture

`src/main/window.ts` wires one `BaseWindow`: a tab-bar `WebContentsView`
(local HTML, `src/tabbar/`) on top and one `WebContentsView` per tab below.
All logic lives in pure, unit-tested modules — `tabManager.ts` (tab
lifecycle; Electron views injected as `TabViewHandle`), `menu.ts` (template),
`navigation.ts` (origin clamp → `shell.openExternal`, offline fallback),
`config.ts` (URL resolution). Keep `window.ts` and `index.ts` free of
decisions; put logic in the pure modules and test it.

All editor views run `contextIsolation: true, sandbox: true, nodeIntegration:
false`; the only bridge is `src/preload/tab.ts`. The whole package compiles
as CommonJS (sandboxed preloads can't be ESM) — no `.js` import-extension
rule here. `src/tabbar/renderer.ts` must compile to a plain script (no
`exports`/`require` in the output — it runs in a CSP'd `<script src>`).

## Cross-repo contract (menu command ids)

Native menu items send pen-editor **command-palette ids** over IPC
`menu:command`; the editor's `src/lib/desktopBridge.ts` dispatches them via
`getCommands()`. Currently used: `file-open`, `file-export-pen`,
`file-export-json`, `file-export-tokens`, `file-import-tokens`. Adding a
menu item = pick an existing `PaletteCommand.id` in
`pen-editor/src/lib/commands/` (or add one there first). Both CLAUDE.md
files list this id set — keep them in sync.

## IPC channels

- `menu:command` main→tab (commandId string)
- `tabbar:state` main→tabbar (`TabsSnapshot`), re-sent on tabbar `did-finish-load`
- `tabbar:new` / `tabbar:activate` / `tabbar:close` tabbar→main (sender-checked)
```

- [ ] **Step 4: Write README.md**

```markdown
# pen-editor-desktop

Electron shell for [pen-editor]: native window, native menus/hotkeys, and
multiple files open as tabs. Each tab loads the deployed editor
(https://pen-editor.onrender.com) — the app is always as fresh as the last
web deploy; offline works via the editor's own service worker after the
first launch. macOS only, unsigned (v1).

- `npm start` — run against production
- `npm run dev` — run against a local `pen-editor` dev server (:5173)
- `npm run dist` — build the .app/.dmg into `release/`
```

- [ ] **Step 5: Update the umbrella CLAUDE.md**

In `/Users/daniilrozhkov/prj/pen-editor-app/CLAUDE.md`, "Repository Layout" section, add a third bullet after the backend one:

```markdown
- `pen-editor-desktop/` — a thin Electron shell (tabs, native menus) loading the deployed frontend; has its own `CLAUDE.md`. Menu items reference pen-editor command-palette ids — see "Cross-repo contract" there.
```

- [ ] **Step 6: Verify everything**

Run in `pen-editor-desktop`: `npm run lint && npm test && npm run test:e2e` — all green.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: electron-builder packaging + repo docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Execution notes

- Tasks 1→6 and 8 run in `pen-editor-desktop`; Task 7 in `pen-editor`. Task 7 only depends on the *contract* (fixed above), so it can run after Task 3, in parallel with 5/6.
- Manual/visual verification (Task 5 Step 6, Task 8 Step 2) needs a display; if the executing agent can't launch windows, flag it for the human instead of skipping silently.
- No pushes to any remote as part of this plan; pushing/releasing is a separate decision.
