# Canvas link: agent panel ↔ canvas tab (desktop agent layout)

Status: protocol for the desktop agent layout (the only desktop layout).
Types: `src/lib/canvasLink/protocol.ts` (pen-editor). Measured basis:
`docs/spike-ipc-streaming-report.md` on branch `spike/ipc-streaming`.

## Roles

- **Agent panel** — the `/agent` route in the left `WebContentsView`. It runs the
  chat (`useDesignChat`) and has NO scene (it has a browser bridge, see Tool placement). Preload: `window.penAgentPanel`
  (`version: 2`, `canvas: AgentPanelCanvasBridge`).
- **Canvas tab** — an editor tab loaded as `/app?chat=off`. It owns one document
  and executes canvas tools. Preload: `window.penDesktop.canvasHost`
  (`CanvasHostBridge`). It calls `register()` once, only in chatless mode.
- **Tool placement** (`src/lib/canvasLink/canvasTools.ts`) — the panel has NO
  scene but HAS its own browser bridge (`window.penAgentPanel.browser`, the same
  `BrowserBridge` shape as `window.penDesktop.browser`). It runs `ask_user`,
  `analyze_image`, `get_guidelines`, `get_style_guide`, `get_style_guide_tags` and
  ALL `browse_*` / `qa_*` tools itself. EVERY other client tool runs in the bound
  canvas tab. A canvas tab is bound or opened only when a tool needs the scene,
  including the `place-node` step of browser tools.
- **Main process** — routes only. It never interprets tool payloads. It knows
  the registered canvas tabs and the one panel per window.

## Binding (chat side)

Each chat is bound to one canvas tab (`tabId`), kept on the chat side. On the
first canvas tool of a turn with no live binding:
1. exactly one canvas tab → bind it;
2. several → the first in the list (the most recently active canvas tab), even if a browser tab is currently active;
3. none → `openTab()` and bind the new tab.
`listTabs()` is ordered most recently active canvas tab first; each
`CanvasTabInfo` has a `registrationId` that increments every time the tab
registers (a reloaded tab keeps its `tabId`, gets a new `registrationId`).
A `tab-gone` (it carries `registrationId`) for the bound registration clears the binding (latch, see below).

## Channels (desktop)

| Channel | Direction | Payload |
|---|---|---|
| `canvas:list` | panel → main, invoke | → `CanvasTabInfo[]` (this window's registered canvas tabs) |
| `browser:reveal-agent-tab` | panel → main, invoke | `{session?}` → `boolean`: makes the agent's browser tab (shared, or that session's) the active tab; false for a non-panel sender, a bad session id or no such tab; never creates a tab or session |
| `canvas:open` | panel → main, invoke | `{activate?}` → `{tabId, registrationId}` (the registration that resolved it) after the new tab called `register()` (timeout 20 s → reject) |
| `canvas:activate` | panel → main | `tabId` |
| `canvas:to-tab` | panel → main | `{tabId, env}` |
| `canvas:from-tab` | main → panel | `{tabId, env}` (from a canvas tab, or main's `error` / `tab-gone`) |
| `canvas:tabs` | main → panel | `CanvasTabInfo[]` on any change (register, close, title, activation) |
| `canvas:register` | tab → main | none; sender must be an editor tab of this window |
| `canvas:unregister` | tab → main | none; sender must be a registered editor tab. Main treats it like `tab-gone` for the current registration (panel gets `tab-gone`, tab leaves the list) |
| `canvas:to-panel` | tab → main | `env` (main adds the sender's `tabId`) |
| `canvas:from-panel` | main → tab | `env` (from the panel, or main's `{kind:"panel-gone"}`) |

Sender checks: `canvas:*` from the panel only from that window's panel view;
from tabs only from registered editor tabs (same pattern as `mcp:register`).
`canvas:to-tab` to an unknown or unregistered `tabId` → main sends
`{kind:"error", refId: env.id}` back to the panel. A registered tab that is
destroyed, navigates (committed main-frame reload), calls `canvas:unregister` or whose renderer dies → main sends
`tab-gone` for it and removes it from the list. Order per sender is kept; no
batching.

When the panel reloads (committed main-frame navigation) or its renderer dies, main sends every registered canvas tab a main-made `{kind:"panel-gone"}` envelope on `canvas:from-panel` (the panel itself cannot: it is gone). The tab must cancel all in-flight work and abandon open streams. A renderer cannot post `panel-gone` (nor `error` / `tab-gone`). The reloaded panel gets a fresh `canvas:tabs` push when its page finishes loading and on its next `canvas:list`.

## Messages

See `protocol.ts`. Rules:

- **Streaming** uses `format: "append"` (only the growth of one string field);
  `"full"` for the first update and as the answer to a `resync`. Measured: 25 KB
  stream = 48 KB over IPC (full JSON: 1.5 MB); 1 MB = 1.2 MB (full: 309 MB).
  Per-message latency p50 0.3 ms; node timing equal to local apply.
- **`call`** carries `timeoutMs` (the chat side's per-tool budget); the canvas
  runs it through `executeToolCall` with that budget and answers `result`.
  The chat side waits `timeoutMs + 2 s` so the canvas's own timeout error wins.
- **`place-node`** is how a panel-run browser tool writes to the scene.
  `browse_capture`, `browse_screenshot` (`placeOnCanvas`) and `browse_agent`'s
  nested capture call `placeNodeOnCanvas` (src/lib/tools/browser/placeOnCanvas.ts:43;
  call sites browseCapture.ts:50, browseScreenshot.ts:77). In the panel this
  function must be redirected to send `place-node` `{callId, node, options}`
  (node without position; `options` = `{x?, y?, size}`) to the bound canvas tab,
  which runs the real `placeNodeOnCanvas` and answers `result` with
  `{"id","x","y"}` or `{"error":...}`.
- **`cancel`** aborts a running call (the canvas aborts the handler's signal and
  still answers `result` with an error, which the chat side ignores if it
  already resolved).
- **`context-request`** carries the chat's `sessionId` and `model` so the canvas
  builds exactly the `canvasContext` the chat would (liked references,
  `selectionHint`). Byte-stable for unchanged state (prompt cache). The chat
  side prefetches it in the transport `body` provider (async allowed) with a
  2 s timeout; on timeout it sends no canvas context rather than a wrong one.
- **`tab-gone` is a latch per registration, not per `tabId`**: the chat side
  immediately fails every pending call for that registration with `{"error":"The canvas tab was closed."}`, abandons its
  open streams and stops forwarding frames for it. (The spike reopened streams
  on the next frame and failed only ~3 s later; that must not happen.) A reloaded
  tab registers again with the same `tabId` and a new `registrationId`; it is
  usable and the latch does not apply to it.
- **Stream integrity**: the decoder accepts only `seq` = last + 1 (first message:
  seq 0, "full"); anything else answers `resync` and ignores appends until a
  "full" arrives. While waiting, every ignored append re-sends `resync`, at most
  once per 250 ms per `toolCallId`.
- **Known limitation**: "append" covers only a top-level string field.
  `edit_embed_html`'s nested `edits[].…` growth falls back to "full" on every
  update. Future work.
- **Chatless robustness**: `isChatDisabled()` is also true when
  `window.penDesktop?.agentLayout === true` (exposed by the editor-tab preload
  in every desktop editor tab), so a reload that dropped `?chat=off` stays
  chatless.
