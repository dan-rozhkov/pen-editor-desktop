# Pineapple Editor

Pineapple Editor is an Electron shell for [pen-editor]: native window, native menus/hotkeys, and
multiple files open as tabs. Each tab loads the deployed editor
(https://pen-editor.onrender.com) — the app is always as fresh as the last
web deploy; offline works via the editor's own service worker after the
first launch. macOS only, unsigned (v1).

- `npm start` — run against production
- `npm run dev` — run against a local `pen-editor` dev server (:5173)
- `npm run dist` — build the .app/.dmg into `release/`

## MCP: let an agent drive the editor

The app runs a **loopback-only** MCP endpoint (`http://127.0.0.1:<port>/api/mcp`,
port picked by the OS at launch) that routes tool calls into whichever editor
tab is focused. On launch it writes `~/.pen-editor/mcp.json` — the same
handshake file `pen-editor-backend` writes for local dev — so
[`pen-editor-plugin`](../pen-editor-plugin) discovers it with **zero
configuration**: install the app, install the plugin, and an agent can call
`get_editor_state`, `batch_design`, etc. against whatever document you have
open. No terminal, no manual token, no local backend required.

- **Coexistence:** if `~/.pen-editor/mcp.json` already points at a live
  server (e.g. a `pen-editor-backend` you're running locally for dev), this
  app is polite and does not clobber it — it stays `not-published`. Use the
  File menu's **"Use this app for MCP"** item to force-publish over it; the
  same not-published state also recovers on its own once the other server's
  handshake entry disappears (it exited, or was never live to begin with).
- **Status:** the File menu has a disabled "MCP: …" line — "listening",
  "not-published", "error" (the local server failed to bind, or its
  handshake file couldn't be written) or off — plus "Use this app for MCP"
  as the escape hatch; for an "error" status it retries. The token and port
  never appear in the UI — only the status string does.
- **Security:** loopback bind only, a random 64-hex bearer token per launch,
  `Host`/`Origin` header checks (rejects anything a browser tab could send),
  `~/.pen-editor/` at `0700` and `mcp.json` at `0600`.

See `pen-editor-desktop/CLAUDE.md`'s "Desktop MCP bridge" section for the
implementation, and `../plans/desktop-mcp-bridge.md` for the full design.
