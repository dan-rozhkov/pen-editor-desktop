# pen-editor-desktop: Electron shell — design

Date: 2026-07-18. Status: approved by user.

## Goal

A thin desktop wrapper for the pen-editor frontend. The editor itself keeps
living on the web (render.com, auto-deploy from `main`); the AI backend stays
remote. The desktop app adds: a native window, native application menus with
hotkeys, and multiple files open at once as tabs. The web/PWA experience is
unchanged.

## Repository layout

`pen-editor-desktop` is a third independent git repository next to
`pen-editor` and `pen-editor-backend` (the parent directory is not a repo).
TypeScript, Electron, electron-builder. It does not import pen-editor code —
it loads the deployed URL.

## Architecture

- **Main process** owns one `BaseWindow` per app window with two layers:
  - **Tab bar**: a small dedicated `WebContentsView` at the top rendering a
    local HTML/CSS tab strip (tab buttons, close buttons, a "+" button).
  - **Tabs**: one `WebContentsView` per open file, each loading the deployed
    pen-editor URL. Dev mode loads `http://localhost:5173` (switched by
    `PEN_DESKTOP_URL` env var / CLI flag). Switching tabs shows/hides views.
    Each tab is an independent editor instance — Pixi/memory isolation is
    free, exactly like browser tabs.
- **Service worker / PWA cache** works inside Electron (https origin), so
  after the first online launch the editor also opens offline.

## Native menus and hotkeys

Application menu: File (New Tab ⌘T, Open… ⌘O, Save ⌘S, Close Tab ⌘W),
Edit (standard roles: undo/redo/cut/copy/paste/selectAll — required for
macOS text fields), View (zoom, fullscreen, toggle DevTools), Window.
Menu commands are sent over IPC to the **active** tab's webContents.

## Preload ↔ frontend bridge (the only pen-editor change)

- Preload script (contextIsolation on, nodeIntegration off, sandbox on)
  exposes `window.penDesktop = { onMenuCommand(cb): unsubscribe }`.
- In pen-editor: a small module that, when `window.penDesktop` exists,
  subscribes and dispatches command names to the existing `fileCommands`
  layer. On the web `window.penDesktop` is absent — zero behavior change,
  PWA untouched.
- The command-name list is the cross-repo contract. It is tiny and must be
  documented in both repos' CLAUDE.md (same discipline as penTools).

## Error handling & hardening

- First launch with no network → local "offline, retry" page with a button.
- `target=_blank` and foreign-origin navigations → `shell.openExternal`;
  in-tab navigation is clamped to the editor origin.
- No Node integration in any editor view; preload is the only bridge.

## Testing

- Vitest unit tests for menu-command routing / tab-manager logic (pure
  modules, Electron APIs injected).
- One Playwright-Electron smoke test: app launches, a tab opens, the URL
  loads — against a local static stub server, no network.

## Distribution

electron-builder → macOS dmg/zip. Unsigned, no auto-updater in v1 (the
shell rarely changes; the editor is always fresh from the server).

## Out of scope (v1)

Opening `.pen` files from disk / file association, Windows & Linux builds,
code signing / notarization.
