# Changelog

All notable changes to **pen-editor-desktop** (the Electron shell) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While on `0.x`, minor bumps may include breaking changes.

## [0.2.0] - 2026-08-09

### Added
- **The app serves MCP itself, so an agent can drive the editor with no terminal and no tokens.** Until now the MCP bridge only worked for someone running the monorepo locally: `VITE_MCP_WS_TOKEN` is inlined at build time, so it cannot be set on a public deployment, and the hosted backend routes to the most-recently-active socket with no per-user scoping. This app already owns the editor tab, so it hosts the bridge instead — main runs a loopback MCP endpoint and routes `tools/call` into its own `WebContentsView` over IPC. It publishes the same handshake contract the backend already uses (`~/.pen-editor/mcp.json`, dir 0700 / file 0600, atomic write), which `pen-editor-plugin`'s proxy discovers with zero configuration. Install the app and the plugin — that is the whole setup; the plugin needed no changes at all.
- **`list_editor_tabs` and explicit `tabId` addressing.** Routing follows `TabManager.activeId` rather than the backend's most-recently-active guess, and any bridged tool accepts an optional `tabId`. Both are answered in main. Both key off `webContents.id`; mixing that with `TabManager`'s own id space already broke every real `tools/call` once, so a test drives every reported id back through routing.
- **Status surface**, because a packaged user has no terminal: an indicator in the tab strip and a "MCP: \<status\>" item in the File menu. It only reports *listening* when the handshake file was really written. "Use this app for MCP" forces ownership.
- **A tool manifest and its generator** (`scripts/gen-tool-manifest.ts`, `src/main/mcp/toolManifest.json`), pinned by a test against the sibling backend's bridged + static tool sets when that repo is present.

### Security
- The endpoint binds narrowly to 127.0.0.1 rather than binding wide and filtering, and adds a constant-time bearer check plus a loopback check as defense in depth. Two checks the backend does not have: `Host` must match the bound address (DNS rebinding), and any request carrying `Origin` is refused — a real MCP client never sends one, a browser always does.
- Replies are keyed by `(tabId, callId)`, so one tab cannot answer another tab's call and hand the agent a forged document.

### Changed
- The app yields to a locally running `pen-editor-backend`: it probes the existing handshake file, refuses to clobber a live owner, and recovers automatically when that owner goes away.
- Lifecycle is app-scoped, not window-scoped — on macOS closing a window does not quit the app, so the server outlives `createMainWindow`.

### Testing
- ~1,900 lines of new tests across handshake, dispatcher, JSON-RPC, HTTP server, service lifecycle, preload and the tool manifest, plus a cross-repo handshake contract test.
- The e2e suite drives the **real plugin binary** with no `PEN_EDITOR_*` environment against the running app — the literal end-user path — and asserts file modes, an unauthenticated 401, and cleanup on quit. The packaged `.app` was verified against production.

## [0.1.0] - 2026-07-19

### Added
- First Electron shell: `BaseWindow` with a tab-bar `WebContentsView` and one view per tab, each loading the deployed editor (`PEN_DESKTOP_URL` overrides; `npm run dev` points at :5173). Tabs sit in the macOS title bar.
- Native menus forward pen-editor **command-palette ids** over IPC (`menu:command`), executed by `src/lib/desktopBridge.ts` on the page side. The id list is pinned by a contract test that lives in the frontend repo.
- Navigation is clamped to the editor origin, with an offline fallback page.
- `electron-builder` packaging: unsigned arm64 dmg + zip via `npm run dist`. macOS only; no auto-updater, no file associations, no signing.
