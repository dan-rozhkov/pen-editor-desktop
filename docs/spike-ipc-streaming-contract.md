# Spike contract: canvas tool streaming over IPC (desktop)

Goal: chat runs in editor tab A, canvas in editor tab B. A forwards canvas tool
streaming partial inputs and tool calls to B through the Electron main process;
B applies them with the existing streaming adapters and executes calls with
executeToolCall; B answers canvasContext requests. Everything is SPIKE code on
branch spike/ipc-streaming; it never merges to main.

## Preload API (pen-editor-desktop src/preload/tab.ts), on window.penDesktop
```ts
surfaceSpike?: {
  /** Declare this tab's role. null = leave the spike. */
  setRole(role: "chat" | "canvas" | null): void;          // ipc "spike:role"    tab->main (send)
  post(env: SpikeEnvelope): void;                          // ipc "spike:post"    tab->main (send)
  onMessage(cb: (env: SpikeDelivered) => void): () => void;// ipc "spike:deliver" main->tab
}
```
## Envelope
```ts
type SpikeEnvelope = { id: string; sentAt: number; msg: SpikeMsg };
// sentAt / relayedAt / receivedAt = performance.timeOrigin + performance.now() (epoch ms, float)
type SpikeDelivered = SpikeEnvelope & { relayedAt: number };
type SpikeMsg =
  | { kind: "stream"; toolCallId: string; toolName: string; seq: number; format: "full"; input: unknown }
  | { kind: "stream"; toolCallId: string; toolName: string; seq: number; format: "append";
      field: string; offset: number; append: string; rest?: Record<string, unknown> }
      // append-only delta of one growing string field (batch_design `operations`, draw_vector path data...).
      // offset = length of the field already sent; receiver rejects (and asks for full via "resync") on mismatch.
      // rest = the other top-level fields, only when they changed since the last message.
  | { kind: "resync"; toolCallId: string }                  // canvas -> chat: send next update as "full"
  | { kind: "stream-end"; toolCallId: string; reason: "complete" | "abandoned" }
  | { kind: "call"; callId: string; toolName: string; input: unknown }
  | { kind: "result"; callId: string; result: string }
  | { kind: "context-request"; reqId: string }
  | { kind: "context-response"; reqId: string; canvasContext: string }
  | { kind: "error"; refId: string; error: string }         // main -> sender: no peer for this envelope
  | { kind: "peer-gone"; role: "chat" | "canvas" };         // main -> remaining tab when the peer tab closed or left
```
## Main routing (pen-editor-desktop)
- Only registered editor tabs (same sender check as mcp:register / browser:command) may use spike:*.
- Roles by webContents id; at most one "chat" and one "canvas" per window: a new setRole replaces the old holder.
- post from chat -> deliver to canvas; post from canvas -> deliver to chat; stamp relayedAt in main.
- No peer -> deliver {kind:"error", refId: env.id, error:"no <role> tab"} back to the sender.
- Peer tab destroyed or setRole(null) -> deliver {kind:"peer-gone", role} to the other side.
- Message order per sender must be preserved (ipc send is ordered; do not reorder or batch).

## Frontend (pen-editor)
- window.__spike = { setRole(role), stats(): SpikeStats, reset() } in all builds of this branch.
- Role "chat": canvas tools (everything except browse_*, qa_*, ask_user, analyze_image) are NOT executed or
  stream-applied locally; partial inputs are forwarded as "stream" (format chosen by window.__spike.format,
  "full" | "append", default "append"), completed calls as "call", awaiting "result". Pending calls fail with
  a JSON {"error": ...} on "peer-gone"/"error". buildCanvasContext's canvasContext comes from a
  "context-request" round trip (timeout 2 s, fallback to the local one, counted in stats).
- Role "canvas": applies "stream" via the existing streaming adapters as if the stream were local, runs
  "call" through executeToolCall, answers "context-request" with the exact canvasContext string.
- Stats (receiver side): per message kind: count, bytes (JSON length of env), latency p50/p95/max
  (receivedAt - sentAt), main hop (relayedAt - sentAt); seq gaps / out-of-order; resyncs; context
  round trips p50/p95 and whether all responses for unchanged state were byte-identical.
