# sideform-computer-use

Long-lived macOS helper that lets the desktop agent control an already running app: Accessibility
(AX) tree, window screenshots (ScreenCaptureKit) and synthetic input (CGEvent). One process per
Sideform main process; JSON lines on stdin/stdout, stderr is a log.

Protocol, element table and error codes: `docs/superpowers/specs/2026-10-21-macos-computer-use-design.md`
(section 1). Error codes: `STALE`, `NO_ACCESSIBILITY`, `NO_SCREEN_RECORDING`, `NO_WINDOW`, `NO_ACTION`,
`NOT_FOUND`, `BAD_ARGS`, `NOT_FRONTMOST`, `POINT_NOT_IN_APP`, plus `TIMEOUT`, `AX_FAILED`, `CAPTURE_FAILED`, `INTERNAL`.

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
  Reply `{"done":true,"via":"AXPress|AXOpen|AXConfirm|AXSelected","effect":"verified|unverified"}`.
  "delivered" = the app accepted the call; "verified" = a re-read confirmed an effect. No advertised step: `NO_ACTION`.
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
