# sideform-computer-use

Long-lived macOS helper that lets the desktop agent control an already running app: Accessibility
(AX) tree, window screenshots (ScreenCaptureKit) and synthetic input (CGEvent). One process per
Sideform main process; JSON lines on stdin/stdout, stderr is a log.

Protocol, element table and error codes: `docs/superpowers/specs/2026-10-21-macos-computer-use-design.md`
(section 1). Error codes: `STALE`, `NO_ACCESSIBILITY`, `NO_SCREEN_RECORDING`, `NO_WINDOW`, `NO_ACTION`,
`AMBIGUOUS`, `NOT_FOUND`, `BAD_ARGS`, `NOT_FRONTMOST`, `POINT_NOT_IN_APP`, plus `TIMEOUT`, `AX_FAILED`, `CAPTURE_FAILED`, `INTERNAL`.

Notes on details the spec leaves open:

- Element `index` is 0-based and valid for one `snapshotId`. The helper keeps the last 8 snapshots per
  pid (the ring of a pid is dropped when its `watch` reports termination). `perform` and `elementFrame`
  take the app `pid` too: when it is given and differs from the snapshot's pid, the answer is `STALE`.
  The TS client always sends it.
- Safety: input only reaches the confirmed pid. `click`, `type`, `key` and `activate` bring the app to the
  front and poll up to about 600 ms; if it is not frontmost then, they send nothing and fail with
  `NOT_FRONTMOST`. `click`, `move` and `scroll` first check that the topmost element at the point (AX
  hit test, else the topmost on-screen layer-0 window) belongs to the pid; otherwise nothing is sent and
  the code is `POINT_NOT_IN_APP`.
- Sideform's own agent-cursor overlay (a click-through window owned by the helper's parent process) is
  transparent to that check: AX hits and CG windows owned by `getppid()` are skipped. Any other foreign
  owner still gives `POINT_NOT_IN_APP`.
- No late execution: a command whose watchdog already answered `TIMEOUT` is skipped when its queue slot
  comes up, so an action reported as failed never happens later. (A command already running is not aborted.)
- App lookup by pid falls back to the main thread when `NSRunningApplication` answers nil off it; that hop waits at most
  0.5 s, then the app counts as not found (`NOT_FOUND`), so a blocked main run loop cannot wedge an AX queue.
- `watch` on a pid that has already exited answers `NOT_FOUND` and keeps no state for it.
- `windows` matches each AX window to the layer-0 CG window of the same pid with the smallest bounds
  distance (each CG id used once). `windowId` is 0 only when no CG window is left or the AX window has no area.
- Timeouts per command (watchdog answers `TIMEOUT`): `snapshot`, `read` 9 s (they may wait up to 4 s for a
  Chromium AX tree to come back); `screenshot`, `perform`, `axScroll` 5 s;
  `type` 10 s; every other command 2 s.
- Headless vs physical. Headless commands (`perform`, `axScroll`, `key`/`type` with `"background": true`) never
  activate the app, move the pointer or take focus. Physical `click`, `move`, `scroll`, foreground `type`/`key`
  and `activate` are unchanged and stay the explicit physical path.
- `perform` `press` is a click chain. It runs only ADVERTISED steps (`AXUIElementCopyActionNames`; some apps
  answer success to actions they never ran): `AXPress`, `AXOpen`, `AXConfirm`, then a write of `AXSelected=true`
  (only when settable and not already true). After a step that returns success it polls up to 400 ms (40 ms
  steps) for a change of a light state (focused element, `AXSelected`, `AXValue`, `AXExpanded`, an `AXMenu`
  child). Change: stop. No change after `AXPress` on an `AXRow`/`AXCell` with settable `AXSelected`: continue to
  the `AXSelected` write. Otherwise stop and never run a second mutating step after a delivered one.
  Errors are classified like agent-desktop's `classify_perform`. Only an error that proves nothing ran
  (`actionUnsupported`, `attributeUnsupported`, `notImplemented`, `illegalArgument`, `noValue`) falls through to the
  next step. `invalidUIElement` is `STALE`. Any other error (`cannotComplete`, `failure` ...) leaves the delivery
  uncertain: the chain stops and replies `{"done":true,"via":<step>,"effect":"unverified","uncertain":true}`.
  Deadline: `perform` and `axScroll` stop mutating 4 s after the request ARRIVED, so queue wait counts (the watchdog answers at 5 s). Past the deadline it
  returns what was already delivered (`unverified`), or `TIMEOUT` when nothing was delivered.
  If a step fails with an error that proves it did not run, the helper first re-reads the state (up to 400 ms): when the state changed, the chain stops with `unverified` and `uncertain: true`.
  Reply `{"done":true,"via":"AXPress|AXOpen|AXConfirm|AXSelected|AXFocused","effect":"verified|unverified"}`.
  "delivered" = the app accepted the call; "verified" = a re-read confirmed an effect. No advertised step and no text-field focus step: `NO_ACTION`.
  Final step for text fields. It runs when no step above delivered anything, the role is `AXTextArea`, `AXTextField`,
  `AXSearchField`, `AXComboBox` or `AXSecureTextField`, `AXFocused` is settable and `AXEnabled` is not false.
  If an earlier step failed and the state changed since the press began, it writes nothing and replies `unverified`
  with `uncertain: true` and the last step as `via`. This check runs before the deadline check. Past the deadline it
  throws `TIMEOUT` when no earlier step existed; after earlier steps that ran nothing it reports their last error
  (usually `NO_ACTION`). If the app's `AXFocusedUIElement` is the element or a descendant of it (up to 20 `AXParent`
  levels), it writes nothing and replies `{"via":"AXFocused","effect":"verified","already":true}`. The element's own
  `AXFocused` alone does not count for `already`: background windows keep a stale `AXFocused`.
  Otherwise it writes `AXFocused=true` and polls for a read-back until the earlier of 400 ms (wall-clock) and the deadline. Every read has its own timeout, bounded by the time left. Here the element's own `AXFocused` also counts. Focus seen: `effect: "verified"`, even if
  the write returned an error. No focus and the write succeeded or failed with an error that does not prove it ran
  nothing: `effect: "unverified"` and `uncertain: true`. No focus and an error that proves it ran nothing: `NO_ACTION`.
  A field that advertises `AXPress` keeps using `AXPress`. This step never activates the app.
- `perform` `insertText` (`text`, optional `replace`): best-effort `AXFocused=true`. With `replace` it must replace
  or fail, never append. Length = `AXNumberOfCharacters` (also works for `AXSecureTextField`), else the UTF-16
  length of the `AXValue` string. Length 0: it just inserts. Length above 0: it selects the whole value through a
  settable `AXSelectedTextRange`; when that is not settable or the write fails (or the length is unknown), the
  reply is `NO_ACTION` ("cannot be replaced through accessibility"). Then it sets `AXSelectedText` (must be
  settable, else `NO_ACTION`; `TIMEOUT` when the deadline has passed). Verify by re-reading `AXValue` (equals text
  with `replace`, contains it otherwise; never for `AXSecureTextField`).
  Reply `{"done":true,"via":"AXSelectedText","effect":...}`.
- `axScroll` `{pid, snapshotId?, index?, windowId?, direction, amount}` (amount clamped 1..20, default 1; timeout
  5 s). One `amount` is about one page (the old wheel step was 500 px). Target: the element's nearest `AXScrollArea`
  (up to 15 parents). Without an element: the largest scroll area inside the window `windowId` (same meaning as in
  `snapshot`; `NO_WINDOW` when it is gone), and only when `windowId` is absent the focused, main or first window
  (BFS, depth 8, 2000 nodes). Chain: (a) a settable scroll bar `AXValue` (0..1): step = visible / (content -
  visible) along the axis (area `AXSize` and the `AXSize` of `AXContents` or the first non-scroll-bar child; 0.1 when
  unknown), set clamp(value +/- step*amount) (`via: scrollbarValue`). It goes first because it is deterministic and
  verifiable. (b) else the area advertises `AXScroll{Up,Down,Left,Right}ByPage`: perform it `amount` times (`page`).
  (c) else the scroll bar advertises `AXIncrement`/`AXDecrement`: perform it `amount*10` times, bounded by the
  deadline (`scrollbar`). (d) else a wheel event posted to the pid only at the area centre, 500 px per amount in
  120 px chunks, with no pointer warp, posted on the global `inputQueue` (the machine-wide input lease) (`wheelToPid`, effect always `unverified`). No area and no frame: `NO_ACTION`.
  For `effect`, a, b and c poll (up to 400 ms) the scroll bar `AXValue`, or else the `AXPosition` of the first
  non-scroll-bar child, against the value before. An AX error does not prove that nothing ran: TextEdit answers
  `AXScrollDownByPage` with `kAXErrorAttributeUnsupported` and still scrolls. So after a failed step the helper
  re-reads the position. If it moved, the chain stops and answers `effect: unverified, uncertain: true`.
- `key` and `type` accept `"background": true`: no activation, no frontmost check, events go to the pid with
  `postToPid` instead of the global HID tap. An unknown key is `BAD_ARGS` before any permission check.
- Queues: AX commands (`windows`, `snapshot`, `perform`, `elementFrame`, `read`, `axScroll`) run on one serial
  queue per pid, created lazily, so a slow app does not block another. Commands without a pid share one queue.
  A pid's queue is removed when its app ends (the `watch` handler). Shared state (snapshot rings, Chromium AX flags) is behind a lock that is never held across an AX call.
  Physical input stays on ONE global serial queue (the machine-wide input lease); background `key`/`type` use it too.
- Read timeout. Before it reads a node, the snapshot, `read` and lookup paths set the AX messaging timeout on that
  element to the smaller of 250 ms and the time left to the command deadline (`snapshot` and `read` measure the
  deadline, 8.2 s, from the arrival of the request) (never below 50 ms: 0 means the global
  default). A node whose read times out is skipped, and the reply says `truncated: true`. Actions (`perform`,
  `axScroll`) keep 1.0 s, because a press on a slow app may take longer. The one-off `AXWindows` listing of the app
  element also keeps 1.0 s, but never past the deadline. Every per-window read of that listing uses 250 ms when a
  deadline is given (1 s without one). Reads of the pre-walk web-content check stop at the poll end (the deadline
  minus the 4.2 s kept for the walk), not at the full deadline.
- Batched read. The walker reads role, subrole, title, description, value, enabled, focused, selected, expanded,
  identifier, placeholder, label, help, hidden, position and size with one `AXUIElementCopyMultipleAttributeValues`
  call per node (options 0). A value that comes back as an AXValue error counts as missing. When the batch fails, the
  walker reads the attributes one by one, with 300 ms in total for that fallback (never past the deadline); when it is
  spent the node counts as timed out. A batch that times out is probed with a 50 ms `AXRole` read, so a hung node costs
  about 300 ms at most, and is then skipped. `AXChildren` stays a separate read: the plain copy first; only when
  it fails with a timeout-like error (`cannotComplete`) and the node reports more than 100 children, ranged pages of
  100. Other failures (no value, unsupported) are an empty list with no extra call. A child read that did not
  finish (failed page, deadline) is reported as incomplete: the snapshot answers `truncated: true` (the walk goes on
  with the siblings and later subtrees), the read
  answers `truncated: true`, and the re-find search below gives up. The value of an `AXSecureTextField` is read only to
  test it for emptiness (`hasValue`). It is never stored or sent.
- Transparent wrappers. A node with role `AXGroup`, `AXGenericElement` or `AXSplitGroup` that has no title,
  description, value, identifier, placeholder or label, and only `AXShowMenu`, `AXScrollToVisible`, `AXFocus` or
  `AXRaise` as actions, does not count toward the depth limit of 60. The walker still goes into it. It was never
  emitted as an element, and it still is not, so index numbers do not change. Deep Electron trees fit the budget.
- Stable references. Each snapshot stores the app's process token (pid + process start time from
  `proc_pidinfo`). When the start time of the pid changed (the app restarted or the pid was reused), `lookup` answers
  `STALE`. For each emitted element the snapshot also keeps the retained `AXUIElement`, its base role and its
  `AXIdentifier`. The retained native object is authoritative: a removed element never silently resolves to another
  one. `lookup` first checks that the snapshot's window still exists (an element of a closed window can still answer reads);
  if not, `STALE` ("The window is gone"). The window picker skips a window whose frame read timed out, so when
  it finds none but the snapshot's CG window id is still listed, the window is not gone: only the retained element
  is read (matching or timed out: used; otherwise `STALE`, "The element is gone"), and the re-find search is skipped. Then it reads the retained element. When the read works, the role matches and
  the identifier matches (if the snapshot saw one), or when the read only times out (alive but slow), the retained
  element is used. When it is gone or its role no longer matches, the element is re-found ONLY if the snapshot saw a non-empty `AXIdentifier`: a search of the window
  (depth 50, at most 5000 nodes, skipping elements outside the window frame like the snapshot walk) for the same base role
  and the same identifier, de-duplicated with `CFEqual`.
  Exactly one match, from a search that finished, is used and replaces the stored element. Several matches are
  `AMBIGUOUS` ("Several elements match. Take a new snapshot."), no match is `STALE`. A search that hits the node cap
  or the deadline (or skips a node whose read timed out, or reads a child list only in part) answers `STALE` with "The window is too large to find the
  element again. Take a new snapshot." An element without an identifier is `STALE` at once: there is no label,
  bounds or child-path matching. The ring of 8 snapshots per pid stays.
- Chromium and Electron activation. When the window has no web content, the helper writes
  `AXManualAccessibility = true` to the app element of EVERY app, unconditionally (harmless where unsupported).
  A success or a read-back of true counts as applied; so does `kAXErrorNotImplemented` (Chromium answers that to a
  write that applied), but only for an app that looks like Chromium (a Qt or Java app would otherwise make the
  helper wait for a web area that never comes). When it did not apply, an app whose bundle holds a Chromium-based framework (a name in
  `Contents/Frameworks` that contains electron, chromium, chrome, brave or vivaldi, or the word cef, edge or opera,
  case-insensitive) gets `AXEnhancedUserInterface` (settable probe, write, read-back), then the helper waits 2 s
  (Chromium debounce), only when the poll end allows it; otherwise it skips the wait and logs a line.
  `AXEnhancedUserInterface` is written only to those apps, because it changes how AppKit apps behave. The time of the
  write is stamped at the write itself, before any wait. The flag is never restored. Activation stays reactive: it
  runs only when the window has no web content, and at most once per 3 s per pid. Then the helper waits for the web
  tree with the delays 25, 50, 100, 200 and then 400 ms, up to the deadline minus the 4.2 s kept for the walk. A
  native window that is still empty waits at most 0.4 s in total.
- `scroll` takes DOM-style deltas: positive `dy` scrolls the content down.
- `key` accepts `key` plus `modifiers`, or a combined `"Meta+a"` string in `key`.
- Slider and incrementor entries get `ops: ["TYPE_TEXT"]` (`perform setValue` with a number).

## Build

```bash
npm run build:native            # skips when native/bin is newer than every .swift file
node scripts/build-native.mjs --force
```

Output: `native/bin/sideform-computer-use`, universal arm64 + x86_64 (arm64 only, with a warning, if the
x86_64 SDK slice fails), deployment target macOS 14, ad-hoc signed. Off macOS or without `swiftc` the
script prints a warning and exits 0. `npm run dist` runs it first; electron-builder ships the binary as
`computer-use/sideform-computer-use` in the app resources.

## Permissions

macOS attributes the helper's requests to its responsible process, Sideform Desktop. Accessibility is
required for everything except `ping`, `permissions`, `listApps`, `watch`. Screen Recording is only needed
for `screenshot`. When running the helper from a terminal, grant the terminal app instead.
`permissions {"prompt": true}` asks macOS for whichever is missing.

## Try it

```bash
echo '{"id":1,"cmd":"listApps"}' | native/bin/sideform-computer-use
```
