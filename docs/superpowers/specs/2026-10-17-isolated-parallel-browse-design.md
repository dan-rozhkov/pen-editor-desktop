# Isolated, parallel browse_agent QA runs — design (2026-10-17)

Cross-repo: pen-editor-desktop (isolated browser sessions), pen-editor
(parallel execution + per-run bridge), pen-editor-backend (rate limit, guidance).
Follows the QA mode (`browse_agent({ qa: true })`, browser-agent
`docs/specs/2026-10-17-qa-suite-design.md`).

## Problem

Today every built-in browser tab shares the partition `persist:penbrowser`
(cookies, storage, saved logins), one `BrowserController` per window drives one
"agent tab", fixture mocks apply to every browser tab, and the frontend runs the
tool calls of one model step strictly one after another. So N QA scenarios run
sequentially and share state.

## Decisions

1. **Only QA runs are isolated.** `browse_agent({ qa: true })` runs in its own
   isolated browser session. A plain `browse_agent` keeps the shared session
   (it needs the user's logins). No new tool parameter. *(Note 2026-10-17: an
   isolated session still starts with no cookies, but it may fill saved logins
   - see "Saved logins" below.)*
2. **Only isolated QA runs are parallel.** In the frontend, a `browse_agent`
   call with `qa: true` on a client that supports isolation does not block the
   tool loop: several such calls of one model step run at the same time, at
   most `MAX_PARALLEL_BROWSE_RUNS = 4` (more wait in a FIFO). Every other tool
   call keeps today's sequential behaviour. The step continues (auto-send) only
   when all its tool calls have outputs (unchanged AI SDK rule).
3. **Fallback.** A desktop shell without `browser.isolated` (older build) or a
   web client without isolated cloud sessions: QA runs stay sequential in the
   shared session, exactly as today.

## Desktop contract (preload `window.penDesktop.browser`)

```ts
browser.isolated(sessionId: string): BrowserBridge   // same methods as `browser`, each call carries the session
browser.closeSession(sessionId: string): Promise<{ ok: true } | { error: string }>
```

- `sessionId`: `^[A-Za-z0-9_-]{1,64}$`; anything else → `{ error: "invalid session id" }`.
- IPC: the existing `browser:command` payload gets an optional `session` field
  (`{ command, args, session? }`), plus a new command `closeSession` (no new channel).
- A session is created lazily by its first page-creating command (`open`,
  `tabs` with `action: "new"`, `applyFixture`, `startJournal`); any other command on a
  missing session → `{ error: "no such browser session" }` (`releaseFixture`/
  `stopJournal`/`captureCheckpoint` answer naturally). It takes one of 6
  app-global in-memory partition slots `qa-0`..`qa-5` (NO `persist:`); with none
  free the command waits FIFO up to 60 s, then `{ error: "too many parallel browser sessions" }`.
  Own `BrowserController` whose target sees ONLY that session's tabs (`tabs list/new/
  switch/close`, popups of a session tab open in the same session). Deny-all
  permissions per slot, CDP debugger + dialog policy like any browser tab. Dialogs
  are auto-handled only while a command of the SAME scope runs.
- Per-session state: controller (snapshot ids, cursor, fixture, journal), fetch
  routing (mocks apply only to that session's tabs), `fresh` resets only that
  session. Saved logins: `fillLogin` works in an isolated session (fill only; it reads the
  session's own agent tab). `label` picks the account by label, else by username.
  The save-prompt capture and favicon cache are off there. *Decision changed
  2026-10-17:* it first returned an error here; users run several scenarios under
  different saved accounts of one site, so the fill is allowed.
- The session is owned by the editor tab that created it (sender webContents id).
  Commands for a session from another editor tab → `{ error }`.
- `closeSession`: tombstones the id (every later command → `{ error: "browser session closed" }`,
  an id is never recreated), waits for in-flight commands, releases fixture/journal,
  closes the session's tabs, wipes the partition, returns the slot. Idempotent.
- Orphans: on the owner editor tab's `render-process-gone`, main-frame
  `did-start-navigation` and destroy, all its sessions are closed (same three
  places as `releaseFixture`).
- Tab strip: session tabs are ordinary browser tabs but open in the BACKGROUND (never
  active, no address-bar focus; the user clicks one to watch). The agent-activity
  icon is per tab and may mark several at once.
- The shared session (`browser.*` without `isolated`) is unchanged.

## Frontend

- `browseAgent.ts`: when `qa: true` and isolation is available
  (`typeof window.penDesktop?.browser?.isolated === "function"`; cloud: see below),
  the run gets `runSession = <toolCallId-derived id>`, uses
  `browser.isolated(runSession)` for every nested browse command, and calls
  `closeSession` in `finally` (every outcome). Nested tool calls must reach the
  per-run bridge: the nested `executeToolCall` context carries the run's bridge or
  session key so `getBrowserBridge(...)` returns the isolated one.
- Per-run keys: loop guard and checkpoint recording key by the run session (not the
  parent chat) for isolated runs, so parallel runs never reset each other's guard
  and each can record its own checkpoint.
- `useDesignChat` `onToolCall`: isolated QA `browse_agent` calls are started and
  NOT awaited; their outputs are added when they finish. Concurrency limit 4.
  Abort (Stop) aborts all running runs.
- Cloud: an isolated run may use its own cloud session keyed `<chatId>.<runSession>`
  if the backend accepts such a key and the session is released at the end;
  otherwise the web client keeps the sequential fallback (decide from the code).

## Backend

- `/api/chat` rate limit (60/min/IP) counts every nested browse request; 4
  parallel runs make ~120/min. Nested browse turns (`agentMode: "browse"`) get
  their own bucket with a higher limit (300/min/IP); main turns keep 60.
- QA guidance: "For several scenarios, call browse_agent several times in the SAME
  step (they run in parallel, each in its own isolated browser)" — only in the QA
  variant of the guidance/description (capability-gated as today).

## Merge order

backend → desktop (no CI; new preload API is additive) → frontend.
