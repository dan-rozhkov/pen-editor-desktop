# macOS computer use: control an already running app without a restart

Date: 2026-10-21. Status: approved for build (the user asked for "variant 2" in autopilot mode; the
calls marked *builder's call* below were made without a question round).

## Why

The agent can already drive a desktop Electron app (`browse_open` with `app`, see
`src/main/appTargets.ts`). It does so over CDP, so the app must start with
`--remote-debugging-port`. An app that already runs is quit and started again. That fails for the
case that triggered this work: Qure Dev runs from a dev server (`npm run dev`, or the isolated-dev
manager). Its bundle is the stock `node_modules/electron/dist/Electron.app`, it lives outside
`/Applications`, and a restart without the dev command line opens an empty Electron window. Nobody
will restart their dev setup with extra flags just to let the agent look.

So: the agent attaches to a window that is already on screen, of **any** macOS app (Electron or
native), without a restart, and without the user changing how they start it.

## Goals

- `browse_open { app }` with the name or the path of a **running** app attaches to it. No restart, no
  flags. The app keeps running after the run.
- The agent sees the window: an element table from the macOS Accessibility tree (`browse_snapshot`,
  `browse_read`) and a screenshot of the window (`browse_screenshot`, ScreenCaptureKit).
- The agent acts: click, type, select, press keys, hover, scroll, wait — the same `browse_act`
  shape it already uses, by `index`+`snapshotId` or by `target` text.
- The user sees where the agent acts: an agent cursor drawn over the app window (the user asked).
- Permissions are explicit: Accessibility (required) and Screen Recording (only for screenshots),
  asked by macOS for Sideform Desktop.

## Non-goals

- Windows/Linux. Starting an app that does not run (that stays the existing CDP launch for Electron
  apps in `/Applications`). Native menus of the menu bar, file dialogs of other processes,
  canvas-rendered content without accessibility (a screenshot shows it, the agent cannot target it).
- Moving the code into `@sideform/browser-agent`. *Builder's call:* it lives in pen-editor-desktop
  first (one consumer, a native helper the package cannot build on Linux CI). A follow-up can move
  the pure TS mapping into the package.

## Anti-goals

- The agent must not take over the user's machine silently: every attach is confirmed in a native
  dialog, like an app launch today.
- Password managers stay blocked; terminals and system settings are high risk (see below).
- A missing permission must never look like "the window is empty" to the model (the Qure incident
  of 2026-10-20: an empty read made the model insist there was no data). It gets an explicit error.

## Architecture

```
renderer (pen-editor, deployed)  -- browser:command IPC -->  main (window.ts onBrowserCommand)
                                                                  |
                                    planAppCommand: launch/route  |  (unchanged routing table)
                                                                  v
                                       appRegistry handle.controller : AppController
                                          |                              |
                          CDP BrowserController (today)      NativeAppController (new)
                                                                  |  JSON lines over stdio
                                                                  v
                                       sideform-computer-use (Swift helper, new)
                                       AX tree · ScreenCaptureKit · CGEvent · NSWorkspace
                                                                  +
                                       AgentCursorOverlay (transparent BrowserWindow, new)
```

### 1. Swift helper `sideform-computer-use`

Source: `native/computer-use/` (Swift Package-free: plain `.swift` files compiled by `swiftc`).
Build: `scripts/build-native.mjs` → `native/bin/sideform-computer-use` (universal arm64+x86_64 via
`lipo`, `-O`, deployment target macOS 14 because `SCScreenshotManager` needs it; ad-hoc
`codesign -s -`). The script is a no-op with a warning on non-darwin or without `swiftc`, so Linux CI
never needs Swift. `npm run dist*` runs it first; `npm run dev` runs it when the binary is missing.
electron-builder copies it with `extraResources` (`native/bin/sideform-computer-use` →
`computer-use/sideform-computer-use`). Path at runtime: `process.resourcesPath/computer-use/...`
when packaged, `<repo>/native/bin/...` otherwise. TCC attributes the helper's requests to its
responsible process, Sideform Desktop, so the user grants **Sideform Desktop**.

Protocol: one long-lived process per Sideform main process. Requests and responses are single-line
JSON on stdin/stdout. Request `{ "id": number, "cmd": string, ...args }`; response
`{ "id": number, "ok": true, ...result }` or `{ "id": number, "ok": false, "error": string, "code"?: string }`.
Unsolicited events have no `id`: `{ "event": "appTerminated", "pid": number }`. stderr is a log.
Every command answers within its own timeout (snapshot and read 9 s, screenshot 5 s, others 2 s); the helper
never blocks the read loop (work runs on a serial queue, AX calls use `AXUIElementSetMessagingTimeout`
of 1 s per element).

| cmd | args | result |
|---|---|---|
| `ping` | – | `{ version: 1 }` |
| `permissions` | `{ prompt?: boolean }` | `{ accessibility: boolean, screenRecording: boolean }`. With `prompt: true`, calls `AXIsProcessTrustedWithOptions(prompt)` and `CGRequestScreenCaptureAccess()` for whichever is missing. |
| `listApps` | – | `{ apps: [{ pid, name, bundleId?, bundlePath?, executablePath?, active, hidden }] }` — `NSWorkspace.runningApplications` with `activationPolicy == .regular`. |
| `windows` | `{ pid }` | `{ windows: [{ windowId, title, x, y, width, height, onScreen, minimized, main, focused }] }` — AX `AXWindows` of the app, matched to `CGWindowListCopyWindowInfo` ids by pid + bounds. Coordinates are global screen points, top-left origin. `windowId` is the CGWindowID (0 when unmatched). |
| `snapshot` | `{ pid, windowId?, maxElements }` | `{ snapshotId, elements: [...], truncated: boolean, window: {windowId,title,x,y,width,height} }` — see "Element table". The helper keeps the `AXUIElement` refs of the last 8 snapshots keyed by `snapshotId`. |
| `perform` | `{ snapshotId, index, action, text?, mode? }` | `{ done: true, via: "ax"\|"event" }`. `action`: `press`, `focus`, `setValue`, `increment`, `decrement`, `showMenu`, `scrollToVisible`, `pick` (select option by `text` in a pop-up/combo). Unknown snapshot → `code: "STALE"`. |
| `elementFrame` | `{ snapshotId, index }` | `{ x, y, width, height }` (fresh AX read). |
| `read` | `{ pid, windowId?, maxChars }` | `{ title, text, truncated }` — visible static text, headings, values, in reading order. |
| `screenshot` | `{ windowId, maxWidth }` | `{ png: base64, width, height, scale }` — `SCScreenshotManager.captureImage` with `SCContentFilter(desktopIndependentWindow:)`, so overlays (our cursor) are never in it. No Screen Recording → `code: "NO_SCREEN_RECORDING"`. |
| `click` | `{ pid, x, y, button?, count? }` | `{ done: true }` — activates the app, remembers the pointer, posts mouseMoved/down/up at the global point, puts the pointer back. |
| `move` | `{ pid, x, y }` | `{ done: true }` — hover: moves the real pointer (and leaves it there). |
| `scroll` | `{ pid, x, y, dx, dy }` | `{ done: true }` — pointer to the point, `CGEvent(scrollWheelEvent2Source:)` in pixel units, pointer back. |
| `type` | `{ pid, text }` | `{ done: true }` — activates the app, `keyboardSetUnicodeString` per chunk of ≤ 20 UTF-16 units. |
| `key` | `{ pid, key, modifiers: string[] }` | `{ done: true }` — `key` in the browse_act vocabulary (`Enter`, `Escape`, `Tab`, `ArrowDown`, `Backspace`, `a`…); modifiers `Meta`, `Control`, `Alt`, `Shift`. |
| `activate` | `{ pid }` | `{ done: true }` |
| `watch` | `{ pid }` | `{ done: true }` — emits `appTerminated` once the pid exits (`NSWorkspace.didTerminateApplicationNotification`). |

Electron/Chromium apps expose an empty AX tree until asked, and Chromium turns it off again by
itself later. On a `snapshot`/`read` whose window has an empty web area, the helper sets
`AXManualAccessibility = true` on the app element (ignored by native apps; at most once per 3 s per
pid, because every set restarts Chromium's ~2 s rebuild delay) and waits up to 4 s for a stable
web-area size. A window whose wait ran out is not waited for again for 60 s. A native app whose
window has no children yet is retried once after 400 ms. It never sets
`AXEnhancedUserInterface` (it breaks window animations).

#### Element table

`elements` use the browser snapshot's shape, so the executor, the step model and the model's
descriptions keep working: `{ index, tag, label, ops, role?, value?, hasValue?, checked?,
expanded?, disabled?, isPassword?, options?, scrollable? }`.

- Walk the window subtree depth-first, children in AX order, visible frames only (frame intersects
  the window), skip `AXHidden`, stop at `maxElements` (`truncated: true`).
- Interactive roles get an entry: `AXButton`, `AXLink`, `AXCheckBox`, `AXRadioButton`,
  `AXPopUpButton`, `AXComboBox`, `AXMenuButton`, `AXTextField`, `AXTextArea`, `AXSearchField`,
  `AXSecureTextField`, `AXSlider`, `AXIncrementor`, `AXTab` (`AXRadioButton` under `AXTabGroup`),
  `AXDisclosureTriangle`, `AXRow`/`AXCell` with `AXPress`, `AXMenuItem` (open menus),
  any element whose `AXActionNames` contains `AXPress` and has a label. `AXScrollArea` gets a
  `scrollable: true` entry with `ops: []`.
- `tag` = the role without `AX`, lower-case (`button`, `textfield`, `checkbox`…). `role` = the raw
  role plus `/subrole` when present.
- `label` = first non-empty of `AXTitle`, `AXDescription`, `AXLabel`… (`kAXDescriptionAttribute`),
  title UI element's title, `AXPlaceholderValue`, `AXHelp`; else `"<tag> #<index>"`. ≤ 160 chars.
- `ops`: `TYPE_TEXT` for text roles (not secure → also `isPassword` false; `AXSecureTextField` →
  `isPassword: true`), `SELECT` for pop-up/combo with `options` (titles of the menu items when the
  AX tree exposes them, else omitted), `CLICK` for everything else that can be pressed.
- `value` for text roles (≤ 200 chars, never for secure fields: `hasValue` only), `checked` for
  check boxes/radios (`AXValue` 0/1), `expanded` (`AXExpanded`), `disabled` (`AXEnabled == false`).

### 2. `NativeAppController` (TS, `src/main/computerUse/`)

Implements `AppController` (`appTargets.ts`) on top of a `ComputerUseHelper` client, for one pid.
It never throws; every failure is `{ error }`.

- `tabs({action})`: `list` → `{ tabs: [{ tabId: windowId, url, title, current }] }` for the
  app's on-screen, non-minimized windows; `url` is `macos-app://<bundleId or name>/<windowId>`.
  `switch` makes `tabId` current. `close`/`new` → `{ error: ERR_NATIVE_TABS }`.
  The current window starts as the focused one, else the main one, else the first.
- `open({url})` → `{ error: ERR_NATIVE_OPEN_LOCKED }` (same intent as `lockNavigation`).
- `snapshot()` → `{ snapshotId, url, title, elements, scroll: { y: 0, height: 0, atBottom: true },
  truncated?, note? }` with `maxElements = 120` (the browser cap). A truncated snapshot carries
  `note` (`NATIVE_LIST_TRUNCATED_NOTE`): `target` searches further, and the app's own search field
  makes the list shorter.
- `perform({snapshotId,index,operation,text})`: `CLICK` → helper `perform press`, and when the
  element has no `AXPress` (`code: "NO_ACTION"`) → `elementFrame` + `click` at its centre.
  `TYPE_TEXT` → `focus` + `setValue`, read back via a fresh `snapshot` entry value; when it did not
  stick → `focus` + `key Meta+a` + `type`. `SELECT` → `pick`. `SCROLL_DOWN`/`SCROLL_UP` (and any
  `SCROLL_*` the executor sends) → `scroll` at the element centre (the window centre without index).
- `act(args)`: one action or `actions` (batch, ≤ 10, stop at first error) with the browse_act
  vocabulary. `click`/`type`/`select`/`hover`/`press`/`scroll` by `index`+`snapshotId`, or by
  `target` (case-insensitive trimmed match against the labels of a fresh snapshot, exact first,
  then substring). When the 120 snapshot is truncated and has no exact match, a second snapshot
  with `TARGET_SEARCH_MAX_ELEMENTS` (1000, the helper's cap) is searched for an exact match, then for
  a substring if the small list had none; its element list never reaches the model. `wait` (`ms`, cap 15000; or `text` polled through `read`). `back`, `forward`,
  `reload`, `upload`, `viewport` → `{ error: ERR_NATIVE_UNSUPPORTED(action) }`. Result
  `{ url, title, matched, changed, snapshot }` where `snapshot` is a fresh one taken 300 ms after
  the action and `changed` compares element labels/values with the snapshot before.
- `read()` → `{ url, title, text, truncated }` (`maxChars` 12000).
- `screenshot({annotate})` → the same result shape the CDP controller returns for a tab (the
  implementer copies it from the package's controller: base64 JPEG, `width`, `height`, `url`,
  `title`), downscaled to ≤ 1280 px wide with `nativeImage`. `annotate: true` adds `snapshotId` and
  `elements` of a fresh snapshot (labels are not drawn; *builder's call*). Missing Screen Recording →
  `{ error: ERR_NO_SCREEN_RECORDING }` (and the helper was asked to prompt).
- `findImages`, `requests` → `{ error: ERR_NATIVE_UNSUPPORTED(...) }`.
- `assert({checks})` (added 2026-10-23, after a QA session where every check failed and turned a
  correct `passed` into `failed`): input validated with `parseQaChecks`. `text` → one `read`
  (`maxChars` 100000), case-insensitive, whitespace squashed; `absent` on a truncated read is an
  error, never a pass. `element`/`value` with `index` → the entry of the latest snapshot the model
  saw in the current window, found again by tag + label in a fresh 1000 snapshot. Presence = any
  element with that tag + label; not found in a truncated snapshot, an unlabeled entry (`<tag> #N`),
  an ambiguous match for a one-element state, no `checked` field, no `value`, or another window →
  `passed:false` with an error. A CSS selector, `count` and `url` → `passed:false` with
  `ERR_NATIVE_CHECK_UNSUPPORTED`. `no_console_errors`/`no_failed_requests` return `passed:true`: the
  package evaluates them from run history, which a native app does not have. Limits: AX skips
  content outside the window frame (absent = not visible), values are clipped at 200 chars.
- Before each action that has a point, it tells the cursor overlay to animate there.

Errors (exported constants, short, written for the model):
- `ERR_NO_ACCESSIBILITY`: "Sideform Desktop has no Accessibility permission. Ask the user to turn on Sideform Desktop in System Settings > Privacy & Security > Accessibility, then call browse_open with app again. Do not retry before the user confirms."
- `ERR_NO_SCREEN_RECORDING`: "Sideform Desktop has no Screen Recording permission, so it cannot take a screenshot of the app. browse_snapshot and browse_read still work. To get screenshots, the user must turn on Sideform Desktop in System Settings > Privacy & Security > Screen & System Audio Recording and restart Sideform Desktop."
- `ERR_NATIVE_OPEN_LOCKED`, `ERR_NATIVE_TABS`, `ERR_NATIVE_UNSUPPORTED(name)`, `ERR_NATIVE_NO_WINDOW` ("The app has no open window. Ask the user to open one."), `ERR_HELPER_MISSING` ("Computer use is not available in this build of Sideform Desktop.").

### 3. Attach flow (`openApp` and the service)

`browse_open { app }` where `app` is a path **or a name**:

1. If computer use is available (darwin + helper binary present), resolve `app` against
   `listApps`: a path matches `bundlePath` (realpath, also a path inside the bundle), a name matches
   `name` or the bundle file name without `.app`, case-insensitive, and — so that "Qure Dev" finds
   the stock-Electron dev process — the title of any of its windows (exact, case-insensitive) or
   the app menu name. Several matches: prefer the frontmost, then the lowest pid.
2. Found → blocked bundle ids refuse (`ERR_APP_BLOCKED`, unchanged list plus `com.apple.keychainaccess`
   and `com.apple.Passwords`). Sideform itself refuses (`ERR_APP_OWN_BUNDLE`). Confirm dialog
   (`confirmAttach`): message "Let the AI agent control <name>?", detail explains that the agent
   sees the window and can click and type in it, that the app is not restarted, and that macOS may
   ask for Accessibility and Screen Recording. Buttons: "Allow once", "Allow until Sideform quits"
   (memoized like today), "Don't allow"; for an Electron app inside the allowed roots also
   "Restart with full access" which takes today's restart path. High-risk apps (today's list plus
   Terminal `com.apple.Terminal`, iTerm2 `com.googlecode.iterm2`, System Settings
   `com.apple.systempreferences`) get only "Allow once"/"Don't allow" and a warning line.
3. Allowed → `permissions` (no prompt). No Accessibility → `permissions {prompt:true}`, open
   `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`, return
   `{ error: ERR_NO_ACCESSIBILITY }`. Otherwise `ticket.launch(path, { native: { pid } })`.
4. Not found, or computer use unavailable → today's path, unchanged (validate Electron in roots,
   confirm, restart if running). When validation fails because the path is not an Electron app or
   is outside the roots, and computer use is available, the error says the app must be running to
   be controlled without a restart, and lists up to 15 running app names.
5. The launch result is today's shape (`shapeLaunchResult`) plus `mode: "computer-use"` and a
   `note` (`NATIVE_MODE_NOTE`): "Attached to the running app without a restart; the user's own
   session. Elements come from the macOS accessibility tree. Actions may bring the app to the front
   and briefly move the mouse pointer."

Registry: `LaunchOptions.native?: { pid: number }`. The service's `launch` builds a
`NativeAppHandle` `{ controller, pid: undefined, onDisconnected, close }` for it (no pid, so the
user's app is never counted as Sideform's or killed; `killSync` only closes the overlay). `close`
removes the overlay and forgets the helper session; it never quits the app. `onDisconnected` fires
on `appTerminated` (helper `watch`) or when the helper dies. The cap (`MAX_RUNNING_APPS`) counts
native handles as well. A native handle holds no profile lock.

### 4. Agent cursor overlay (`src/main/computerUse/cursorOverlay.ts`)

A transparent, frameless, non-focusable `BrowserWindow` per native handle, `setIgnoreMouseEvents(true)`,
`setAlwaysOnTop(true, "screen-saver")`, `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`,
`hasShadow: false`, shown inactive, covering the target window's frame (re-read before each action).
Its page (inline HTML, no remote content, no preload, `sandbox: true`) is an empty transparent document;
each move runs browser-agent's `CURSOR_JS` in it (the script browser tabs use), so the arrow, motion, glow,
click ripple and 8 s idle fade are identical to browser use. The point is window-local and the action kind
(`click`, `type`, `select`, `scroll`, `hover`, `press`) is passed through; `CursorSink.moveTo` returns a
promise that the controller awaits, so the action starts after the cursor arrives (bounded to 900 ms, and it
never fails the action). It follows the existing "Show Agent Cursor" setting; when the setting is off, no
overlay is created. Screenshots never include it (window-only capture). The window hides 8.4 s after the
last move (after the 8 s fade) and on close.

### 5. Backend text (pen-editor-backend)

New client capability `browseNativeApps: boolean` (`routes/chat.ts`, `chatTurn.ts`), honoured only
with `browser: "desktop"` **and** `browseApps`. When on, `browseToolText.ts` uses native-aware
variants of `openApp`, the browse_agent `app` field and `APP_PROFILE_FACTS`; when off, every byte
stays as today (the golden tests prove it). The variant says: `app` may be the app name as shown in
the Dock or window title (for example "Qure Dev") or a `.app` path; an app that is already running
is controlled without a restart, any macOS app, through its accessibility tree and window
screenshots, in the user's own session; elements' `tag` is the accessibility role; browse_tabs lists
its windows; back/forward/reload/upload/viewport, browse_find_images and browse_capture
are not available there; QA checks work only for text, and for element or value with an index; a permission error must be passed to the user, not retried; actions may
bring the app to the front and move the pointer, so do not act faster than needed.

### 6. Frontend (pen-editor)

`chatTransport.ts` sends `browseNativeApps: desktopNativeAppsAvailable()`, true when the desktop
bridge has `launchApp`, `releaseApp` and `nativeApps === true`. The desktop preload exposes
`nativeApps: true` on darwin (`agentPanel.ts`, `tab.ts`). `desktopBridge.ts` types it. Nothing else
changes: `app` already passes through as a trimmed string.

Merge order: backend → frontend → desktop (an unknown capability is stripped by zod, so any order
is safe; this order means the text exists before a client claims it).

## Testing

- Desktop unit tests (Linux CI, no Swift): the helper client against a fake child process
  (framing, ids, timeouts, helper death → pending calls reject, `appTerminated`), the
  `NativeAppController` against a fake helper (every op path, AX-press fallback to click, type
  read-back fallback, stale snapshot, unsupported actions, permission errors), the app resolver
  (path/name/window-title matching, ties), `openApp` native branch (blocked, high risk, deny, attach,
  no Accessibility, fallback to restart path, not running), registry with `native` (no pid, cap,
  close never quits).
- Desktop darwin-only test (skipped elsewhere): builds nothing, but if `native/bin/sideform-computer-use`
  exists it runs `ping`, `listApps`, `permissions`.
- Backend: golden texts unchanged without the flag; new variant snapshot with it; capability gate.
- Frontend: `desktopNativeAppsAvailable` and the transport field.
- Live: build the helper, run it from a terminal against Finder/TextEdit (needs Accessibility for
  the terminal); report honestly what could not be checked.

## Left to the builder

Exact Swift structure, the AX attribute fallback order inside the stated rules, overlay artwork,
batching details, the exact text wording within the stated meaning.
