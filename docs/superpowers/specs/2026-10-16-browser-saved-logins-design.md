# Saved logins in the built-in browser (desktop)

Date: 2026-10-16. Repos: pen-editor-desktop, pen-editor-backend, pen-editor.
No change to `@sideform/browser-agent`.

## Intent

QA runs in the desktop app. The browsing subagent (`browse_agent`) must sign
in to a test site with a login the user prepared before, and continue the task.
Today it stops: the package prompt says "Never type a password", and the user
has to sign in by hand.

The password must never reach the model, the chat, `raw_traces`, the agent
log, or analytics. The desktop main process holds the secret and types it into
the page itself. The model only asks "fill the login here".

## Goals

1. A password store next to the built-in browser (like Chrome's password
   manager), in the desktop main process, encrypted with Electron `safeStorage`
   (macOS Keychain).
2. Two ways to add an entry:
   - **Save prompt.** After the user signs in by hand in a browser tab, a
     native dialog asks "Save password for <site>?" (only after the tab navigates, see "Save prompt") (Save / Never for this site
     / Not now).
   - **Passwords window.** Menu item opens a small window: list entries (origin,
     username, label), add, delete, and remove a host from the "never" list.
3. A new subagent tool `browse_fill_login`. The desktop finds the sign-in
   fields on the current page, types the saved username and password, and
   optionally submits. The result holds no secret.

## Non-goals

- Web / Steel cloud browser (later). The tool is offered only when the
  frontend runs in the desktop and the bridge has `fillLogin`.
- Sync, import from Chrome, OTP / 2FA codes, passkeys.
- Changes to the browser-agent package (prompt core stays, see "Prompt").
- `browse_task` (legacy loop) and the main chat model's manual browse tools.

## Anti-goals (a failure even if it works)

- A password in any tool input, tool result, chat card, trace, log or
  analytics event.
- A password sent to the Passwords window renderer after it is saved (the
  list shows origin, username, label only).
- Filling a saved password into a page whose origin (scheme, host, port) does not match the entry
  (prompt-injection / phishing case), or into an iframe.
- A page that can trigger the save flow or read the store by itself.

## Design

### Desktop (pen-editor-desktop)

**`src/main/browser/credentialStore.ts`** — pure, Electron-free (inject
`encrypt(string): Buffer`, `decrypt(Buffer): string`, `isAvailable()`, and
file read/write), unit-tested like `cursorSettings.ts`/`service.ts`.

- File: `path.join(app.getPath("userData"), "browser-credentials.json")`,
  shape `{ version: 1, entries: [{ id, origin, username, label, password, lastUsedAt? }], never: [host] }`.
  `password` is base64 of `safeStorage.encryptString`. Username and label are
  plain text.
- `origin` is a normalized `scheme://host[:port]`: http or https only,
  lowercase host, a leading `www.` and a trailing dot removed, the scheme's
  default port dropped, no path. Match rule: scheme, host and port all equal
  the page's after the same normalization (`http://example.com` and
  `https://example.com:8443` do not match `https://example.com`). No
  subdomain or eTLD+1 matching (strict on purpose). A bare host typed in the
  Passwords window means https. The `never` list stays hostname-only.
  The file parser accepts only this shape (`version: 1`, entries with a
  normalized `origin`); there is no migration (the feature is unreleased).
  A file that is not valid JSON, not an object, or has another `version` reads
  as empty, and before the first write it is renamed to
  `browser-credentials.json.bad-<timestamp>` (kept, one log line without
  content). If that rename fails the write is refused with a fixed error
  (unless it failed with ENOENT: the file is gone, nothing to protect). The
  same backup happens when any entry fails validation (the valid ones stay in
  memory) and when reading fails with anything but ENOENT.
- A stored password is bounded only by a generous sanity limit on read
  (64 KB of base64); `add` limits the password to 1024 characters, whose
  UTF-8 ciphertext can be much longer than 1024 bytes.
- API: `list()` → `{ id, origin, username, label }[]`; `add({ site, username, password, label? })`
  (same origin + username replaces the password); `remove(id)`;
  `findForOrigin(url, label?)`; `classify(url, username, password)` (trims the username like `add`); `isNever(host)`, `addNever(host)`, `removeNever(host)`;
  `listNever()`. `add` throws if encryption is not available. A corrupt or
  missing file reads as empty, like `cursorSettings.ts`.
- Choosing an entry: with `label`, the entry on that origin whose label equals
  it (case-insensitive), else an error that lists the labels on that origin.
  Without `label`: the only entry, else the most recently used one
  (`lastUsedAt`, set on every fill).

**`browser:command` → `fillLogin`** (new case in `window.ts`'s switch, logic
in a pure module `src/main/browser/fillLogin.ts` with the controller and store
injected):

1. Read the agent's current browser tab URL. Reject non-http(s).
2. Find the entry for that origin. None → `{ ok: false, error: "No saved login for <origin>. ..." }`.
3. Take a fresh snapshot with `browserController.snapshot()` (its own
   `snapshotId`; the model's next action takes a new snapshot anyway).
4. Pick fields from `elements`, top document only (skip any element with a
   `frame`):
   - password field: first element with `isPassword: true` and `TYPE_TEXT` in `ops`.
   - username field: the nearest element before the password field (by
     `index`) that is a plain text input. The snapshot has NO input type and
     no `autocomplete` for text fields (`inputType` is set only for
     checkbox/radio), so "plain" is decided on what an element really carries:
     `tag` input, ops with both `TYPE_TEXT` and `CLICK` (range/password offer
     only `TYPE_TEXT`), no `options`/`expanded`/`checked`, no widget `role`
     (combobox, searchbox, spinbutton, slider...), not disabled, and a `label`
     that is not a search/number/date/code one. A search or number field with
     an innocent label cannot be told from a text field; that is accepted.
     Without a password field, the label must also look like a login field
     (user/email/login/логин/почт/phone).
     With no password field on the page (two-step sign-in, page 1), fill only
     the username field if one matches; with neither, return an error.
5. Type with `browserController.perform({ operation: "TYPE_TEXT", index, text, snapshotId })`.
6. If `submit: true`, press Enter in the last filled field
   (`perform PRESS_ENTER` or the controller's existing key path).
   The origin is re-checked before and after each `perform`. Known limit: a
   cross-origin navigation during the cursor animation before `insertText`
   cannot be fully prevented from this layer.
7. Return only `{ ok, origin, label, filled: ("username"|"password")[], submitted }`
   or `{ ok: false, error }`. Never pass through controller results as-is
   (they can carry `changes`, `dialogs`, page text). Any error text from the
   controller is replaced by a fixed message.

Preload `src/preload/tab.ts`: `browser.fillLogin(args)` → `invoke("browser:command", { command: "fillLogin", args })`.
`args` is `{ label?: string, submit?: boolean }` only.

**Save prompt** (`src/main/browser/loginCapture.ts`, pure parts tested):

- On each browser tab's CDP session (window.ts already attaches the debugger
  and fans out `cdpEventListeners`): on every main-frame `Page.frameNavigated`
  main creates the isolated world (`Page.createIsolatedWorld`), adds the
  binding to that context id and runs the script there (no `Runtime.enable`;
  see CLAUDE.md). The page's main world cannot see the binding.
- The script runs in the top frame only. On `submit` (capture phase), on a
  click on a button/`[type=submit]` inside a form, and on Enter in a field of
  a form, it reads the form's password field and the username field (same
  rule as above, by DOM order) and calls the binding with
  `{ username, password, origin }` when the password is non-empty, where
  `origin` is `location.origin` read at submit time. A form with two or more
  password fields (change-password, sign-up with a confirm field) is never
  captured.
- Main side, on `Runtime.bindingCalled`: accept the event only when its
  `executionContextId` equals the isolated-world context main created for the
  tab's CURRENT document (a page's main world cannot call the binding, and a
  stale document's context is dropped on navigation). File the login under
  the payload's `origin` (captured at submit time, so a fast navigation
  cannot move it to another site), never under the tab's later URL.
- Do not ask right away: a mistyped password is "submitted" too. Hold the
  capture in memory and prompt only if the tab then has a main-frame
  navigation (`Page.frameNavigated`) or a same-document navigation of the top
  frame (`Page.navigatedWithinDocument` whose `frameId` is the top frame)
  within 5 s; otherwise drop it. A newer submit replaces the held one.
  Like Chrome, a navigation is not success by itself: once the new document is
  ready (bounded to 3 s) the isolated world checks for a visible
  `input[type=password]` in the top document; if there is one the sign-in
  form is back (wrong password) and the capture is dropped without a prompt.
  Late CDP results for an older document are discarded by a per-tab generation
  counter.
- At prompt time skip when the host is on the never list, when an identical
  entry exists, when encryption is unavailable, or when a prompt is already
  open. Otherwise show
  `dialog.showMessageBox(window, { message: "Save password for <site>?", detail: "<username>", buttons: ["Save", "Never for This Site", "Not Now"] })`
  (`<site>` is the origin without `https://`). An existing entry with the same
  username and another password → "Update password for <site>?", and there the
  default and cancel button is "Not Now" (a typo must not overwrite a good
  password by pressing Enter).
- Agent fills are the same as the stored entry, so they never prompt.

**Passwords window** (`src/passwords/` HTML+CSS+renderer like `src/tabbar/`,
preload `src/preload/passwords.ts`): a `BaseWindow` + one `WebContentsView`,
single instance (focus if open), opened from a menu item "Passwords…" (View
menu, or a "Browser" group — builder's call, keep it with the browser items).
While it is focused, every main-window menu action is ignored and the global
Close Tab item (Cmd/Ctrl+W) closes this window (`closeTarget.ts`, wired in
`window.ts`; `menu.ts` forwarding is unchanged).
IPC channels (invoke/handle, sender-checked against that window's
webContents): `passwords:list`, `passwords:add`, `passwords:remove`,
`passwords:never-remove`. The renderer never receives a password. Add these
channels to the CLAUDE.md IPC table and to `test/ipcContract.test.ts`'s
expectations. CSP like the tab bar.

### Backend (pen-editor-backend)

- `src/ai/tools.ts`: client-executed `browse_fill_login` (no `execute`),
  input `{ label?: string, submit?: boolean }`. Description (plain, short
  sentences): it types a login the user saved in the desktop browser into the
  sign-in form of the current tab; the subagent never sees the password;
  with `label`, it uses that saved account; `submit: true` also presses Enter;
  after it, take a snapshot; an error means no saved login for this site, so
  stop as for a login wall. Results `{ ok, origin, label, filled, submitted }`.
- `src/routes/chat.ts` / `chatTurn.ts`: body flag `browseLogin?: boolean`
  (mirrors `browseCapture`). In a `browse` turn, add `browse_fill_login` to
  the allowlist only when it is true, and remove it from every other turn's
  tool set (the main model never gets it).
- `src/ai/system-prompt.ts`: a second built prompt
  `BROWSE_AGENT_LOGIN_PROMPT` = `buildBrowseAgentPrompt` with one extra
  guidance bullet, chosen in `chatTurn.ts` when `browseLogin` is true. The
  prompt stays constant within a session (prompt-cache invariant). Bullet,
  in substance: "Exception to the password rule: `browse_fill_login` is
  available. On a sign-in form, call it instead of stopping. It types a login
  the user saved. Never type a password yourself. Then take a snapshot and
  continue. If it returns an error, stop as for a login wall."
- `AGENT_BROWSER_GUIDANCE` (main model): one sentence — in the desktop app
  the subagent signs in by itself when the user saved a login for the site in
  the browser's Passwords window; never ask the user to type a password in
  the chat; if the user names a saved account, put its label in `goal`.
- Tests: tool contract name list, allowlist gating (present only with the
  flag in browse turns, absent in the main turn), prompt selection.

### Frontend (pen-editor)

- `toolRegistry.ts`: handler `browse_fill_login` → `getBrowserBridge()`;
  when the bridge has no `fillLogin` (cloud), return an error string. Pass
  only `{ label, submit }` (strip any other key). The result string is the
  desktop result JSON as-is (it holds no secret).
- `browseAgent.ts`: when the bridge is the desktop bridge and has
  `fillLogin`, send `browseLogin: true` in the nested chat body. No
  `singleUseTool` wrapper (a two-step sign-in calls it twice).
- Bridge type (`bridge.ts` / desktop typings): optional `fillLogin`.
- The seven tool-name places (registry, contract test list, `toolIcons`,
  `toolDisplayNames`, no timeout override needed — a fill is < 30 s).

## Merge order

Backend first (schema + allowlist), then frontend, then desktop. The
frontend only sends `browseLogin` when the desktop bridge has `fillLogin`, so
an old desktop build with a new frontend keeps today's behaviour.

## Left to the builder

Exact menu placement and wording, Passwords window layout, the
username-field heuristic details, how Enter is pressed after fill.
