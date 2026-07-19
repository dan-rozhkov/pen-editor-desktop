# Pineapple Editor

Pineapple Editor is an Electron shell for [pen-editor]: native window, native menus/hotkeys, and
multiple files open as tabs. Each tab loads the deployed editor
(https://pen-editor.onrender.com) — the app is always as fresh as the last
web deploy; offline works via the editor's own service worker after the
first launch. macOS only, unsigned (v1).

- `npm start` — run against production
- `npm run dev` — run against a local `pen-editor` dev server (:5173)
- `npm run dist` — build the .app/.dmg into `release/`
