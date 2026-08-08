# CLAUDE.md — pen-editor-desktop

Thin Electron shell for pen-editor. The editor itself is NOT here — each tab
is a `WebContentsView` loading the deployed frontend
(`https://pen-editor.onrender.com/app`, override with `PEN_DESKTOP_URL`;
`npm run dev` points it at a local Vite dev server on :5173). The frontend
serves its showcase gallery at `/` and the editor at `/app`, so both the
default URL and any override must include the `/app` path — an override is
used verbatim. The AI backend stays remote. Design spec: `docs/superpowers/specs/2026-07-18-electron-shell-design.md`.

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

The contract is enforced from the **pen-editor** side:
`pen-editor/src/lib/__tests__/desktopMenuContract.test.ts` imports this repo's
`src/main/menu.ts` (loadable without `npm ci` — the electron import is
type-only), clicks every item with recording actions, and asserts the
forwarded ids both match its pinned list and resolve through `getCommands()`.
pen-editor's `contract` CI job checks out this repo's `main` at run time, so a
menu id typed only here is caught there, not in this repo — this repo has no
CI of its own. Adding or renaming a forwarded id means touching four places:
`menu.ts`, that test's pinned list, and both CLAUDE.md files.

## IPC channels

- `menu:command` main→tab (commandId string)
- `editor:document-title` tab→main (document display name, normalized to `Untitled`)
- `editor:theme` tab→main (`light` | `dark`, observed from the editor's root class)
- `tabbar:state` main→tabbar (`TabsSnapshot`), re-sent on tabbar `did-finish-load`
- `tabbar:theme` main→tabbar (`light` | `dark`, active editor theme or system fallback)
- `tabbar:new` / `tabbar:activate` / `tabbar:close` tabbar→main (sender-checked)
