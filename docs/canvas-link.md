# Canvas link: agent panel ↔ canvas tab (desktop agent layout)

Status: protocol for the desktop agent layout (flag `PEN_DESKTOP_AGENT_LAYOUT=1`).
Types live in pen-editor `src/lib/canvasLink/protocol.ts` (this doc is a copy; refreshed from pen-editor). Measured basis:
`docs/spike-ipc-streaming-report.md` on branch `spike/ipc-streaming`.

## Roles

- **Agent panel** — the `/agent` route in the left `WebContentsView`. It runs the
  chat (`useDesignChat`) and has NO scene. Preload: `window.penAgentPanel`
  (`version: 2`, `canvas: AgentPanelCanvasBridge`).
- **Canvas tab** — an editor tab loaded as `/app?chat=off`. It owns one document
  and executes canvas tools. Preload: `window.penDesktop.canvasHost`
  (`CanvasHostBridge`). It calls `register()` once, only in chatless mode.
- **Main process** — routes only. It never interprets tool payloads. It knows
  the registered canvas tabs and the one panel per window.

## Binding (chat side)

Each chat is bound to one canvas tab (`tabId`), kept on the chat side. On the
first canvas tool of a turn with no live binding:
1. exactly one canvas tab → bind it;
2. several → bind the active one (`listTabs()` `active`);
3. none → `openTab()` and bind the new tab.
A `tab-gone` for the bound tab clears the binding (latch, see below).

## Channels (desktop)

| Channel | Direction | Payload |
|---|---|---|
| `canvas:list` | panel → main, invoke | → `CanvasTabInfo[]` (this window's registered canvas tabs) |
| `canvas:open` | panel → main, invoke | `{activate?}` → `{tabId}` after the new tab called `register()` (timeout 20 s → reject) |
| `canvas:activate` | panel → main | `tabId` |
| `canvas:to-tab` | panel → main | `{tabId, env}` |
| `canvas:from-tab` | main → panel | `{tabId, env}` (from a canvas tab, or main's `error` / `tab-gone`) |
| `canvas:tabs` | main → panel | `CanvasTabInfo[]` on any change (register, close, title, activation) |
| `canvas:register` | tab → main | none; sender must be an editor tab of this window |
| `canvas:to-panel` | tab → main | `env` (main adds the sender's `tabId`) |
| `canvas:from-panel` | main → tab | `env` |

Sender checks: `canvas:*` from the panel only from that window's panel view;
from tabs only from registered editor tabs (same pattern as `mcp:register`).
`canvas:to-tab` to an unknown or unregistered `tabId` → main sends
`{kind:"error", refId: env.id}` back to the panel. A registered tab that is
destroyed, navigates (main-frame reload) or whose renderer dies → main sends
`tab-gone` for it and removes it from the list. Order per sender is kept; no
batching.

## Messages

See `protocol.ts`. Rules:

- **Streaming** uses `format: "append"` (only the growth of one string field);
  `"full"` for the first update and as the answer to a `resync`. Measured: 25 KB
  stream = 48 KB over IPC (full JSON: 1.5 MB); 1 MB = 1.2 MB (full: 309 MB).
  Per-message latency p50 0.3 ms; node timing equal to local apply.
- **`call`** carries `timeoutMs` (the chat side's per-tool budget); the canvas
  runs it through `executeToolCall` with that budget and answers `result`.
  The chat side waits `timeoutMs + 2 s` so the canvas's own timeout error wins.
- **`cancel`** aborts a running call (the canvas aborts the handler's signal and
  still answers `result` with an error, which the chat side ignores if it
  already resolved).
- **`context-request`** carries the chat's `sessionId` and `model` so the canvas
  builds exactly the `canvasContext` the chat would (liked references,
  `selectionHint`). Byte-stable for unchanged state (prompt cache). The chat
  side prefetches it in the transport `body` provider (async allowed) with a
  2 s timeout; on timeout it sends no canvas context rather than a wrong one.
- **`tab-gone` is a latch**: the chat side immediately fails every pending call
  for that tab with `{"error":"The canvas tab was closed."}`, abandons its
  open streams and stops forwarding frames for it. (The spike reopened streams
  on the next frame and failed only ~3 s later; that must not happen.)
