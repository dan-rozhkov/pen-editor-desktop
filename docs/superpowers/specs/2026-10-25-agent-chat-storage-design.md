# Agent chat storage on the desktop (2026-10-25)

## Intent

The agent panel (`/agent`) keeps its chats only in memory (`pen-editor`
`src/store/chatStore.ts` + one AI SDK `Chat` per session). A panel reload or
an app restart loses every chat. Sideform Desktop must keep the chats on disk
and show them again after a restart.

## Decision: JSON files, not a database

Chats are stored like canvases (`canvasStore.ts`): two JSON files per chat in
`<userData>/chats/` (`<userData>/chats-dev/` while `PEN_DESKTOP_URL` is set).
Reasons:

- The shell already has two stores of this shape (`docStore`, `canvasStore`)
  with tested helpers (`storeUtils.ts`, tmp + rename, rev rules, temp sweep).
- A chat is read and written as one unit. The list needs only small metadata.
  There are no queries that need SQL.
- No native module (better-sqlite3 needs a rebuild per Electron version;
  `node:sqlite` is still experimental). No migration framework.
- The files are easy to inspect, back up and delete by hand.

## Files

- `<id>.meta.json` = `{ id, title, titleIsAuto, model, updatedAt, rev, messageCount }`
- `<id>.chat.json` = `{ id, rev, messages }` (`messages` = the AI SDK `UIMessage[]`, as JSON)

Rules (same as `canvasStore`):

- Each file is written tmp + rename, mode 0o600. Body FIRST, then meta.
- id = `isValidChatId`: `^[A-Za-z0-9_-]{1,128}$` (the frontend's `generateChatId` ids must pass; check its format).
- title <= 10 000 chars, model <= 200 chars, body JSON <= 64 MB UTF-8, `rev` a positive safe integer,
  `updatedAt` a finite number, `messages` an array, `messageCount` = `messages.length`.
- **Newer rev wins**: a save whose `rev` is not above the stored meta `rev` writes nothing and returns
  `{ ok: true, stale: true, rev }`. Per-id promise chain, in-memory rev cache.
- `list` reads ONLY meta files, sorts by `updatedAt` descending, sweeps temp files older than 1 hour.
- `read(id)` returns `{ chat }` (meta fields + `messages`), or `{ chat: null }` when meta or body is
  missing, unreadable, or the body `rev` is below the meta `rev`.
- `delete(id)` removes both files; a missing chat is `{ ok: true }`.

## IPC (invoke; errors come back as `{ error }`)

- `chats:list` -> `{ chats: ChatMeta[] }`
- `chats:read(id)` -> `{ chat: StoredChat | null }`
- `chats:save(StoredChat)` -> `{ ok, rev, stale? }`   (`StoredChat` = meta fields minus `messageCount` + `messages`)
- `chats:delete(id)` -> `{ ok }`

Only the agent panel webContents (its own page, not the offline fallback) may call them. Every other
sender gets `{ error: "chats:<op> is not allowed from this sender" }`. Handlers are registered ONCE per
process and removed on `will-quit`.

Preload: `penAgentPanel.chats = { list, read, save, remove }`. Panel `version` stays 2. The
frontend feature-detects the four functions.

## Quit flush

Main runs `typeof window.penChatsFlush === 'function' ? window.penChatsFlush() : undefined` in the
agent panel (via `executeJavaScript`, bounded by the shared `withTimeout`, 3 s) in the same
`before-quit` hold that flushes canvas tabs, and before a window with a panel closes. The page
resolves it after its pending chat saves got their replies. It never rejects.

## Frontend (pen-editor)

Only where `window.penAgentPanel.chats` exists. The web build and the editor's own chat do not change.
Hydration is eager: there is no loading state, no send blocking and no history merge.

- **Startup:** `list()`, then `read()` every chat (6 at a time, each call bounded by a 10 s timeout).
  The messages are sanitized and parked in a module map keyed by chat id. Then the summaries are added to
  `chatStore.chats` as closed, idle chats (`unread: false`, `isBusy: false`, `needsAnswer: false`,
  `parallelCount: 1`) with their `title`, `titleIsAuto`, `model`, `updatedAt`. A chat whose read fails,
  times out or returns nothing is NOT added; its file stays untouched and a warning is logged. Ids already
  in the store are skipped. The current empty start chat stays.
- **Session creation:** `useOwnedChat` builds the `Chat` with `messages: takeInitialMessages(id)`, which
  returns and deletes the parked history (`undefined` for any other chat). A restored chat therefore starts
  with its full history.
- **Sanitize on load:** a tool part not in a terminal state (`output-available`, `output-error`,
  `output-denied`) becomes `output-error` with `errorText: "Interrupted: the app closed before this tool finished."`
  (its input is kept, or `{}`); a `text` / `reasoning` part still `streaming` becomes `done`; an assistant
  message left with no parts, or only empty text, is dropped. A history with an unresolved tool call makes
  every later request fail.
- **Handles:** each session registers its `Chat` with the persistence module on mount and on every
  messages/status change. The module keeps the handle until the chat is deleted, and also subscribes to the
  `Chat`'s own callbacks, so a turn that settles after the session unmounted still schedules a save.
- **Save:** the module keeps a snapshot per chat (messages identity, `title`, `titleIsAuto`, `model`). For a
  restored chat it starts as the loaded state, so an untouched restored chat is never rewritten, not even by
  flush. A chat with at least one message whose state differs from the snapshot is saved, debounced (300 ms),
  after it settles (`ready` or `error`). A title or model change saves with the handle's current messages (or
  the snapshot's, when no session exists). `rev` starts at the listed meta `rev` and is last known + 1; on a
  stale reply the module adopts the reply's `rev` and retries once. Never save mid-stream, except in flush.
  A failed save only warns in the console.
- **Delete:** a chat leaving `chatStore.chats` (`closeChat`, including the last-chat replacement) cancels its
  timer and deletes its file when it was ever written or a save is in flight (the remove is chained after
  that save). Clearing a written chat's messages deletes it too (an empty chat is not stored). A failed
  remove keeps the known `rev`.
- **Flush:** `window.penChatsFlush` saves every chat that has a pending timer, or a handle whose state differs
  from its snapshot, now and regardless of status, then awaits all disk operations. It never rejects.
- **Titles:** `createChat` names a chat `Chat N` with the smallest `N >= 1` no existing title `Chat N` uses,
  so new chats do not collide with restored ones.

## Not stored (non-goals for now)

Activity notes, liked references, context-token readings, composer drafts and attachments, browse
checkpoints, cloud browser handles. Chat search, export and sync to the server are out of scope.
