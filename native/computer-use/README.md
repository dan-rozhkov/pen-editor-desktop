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
  Chromium AX tree to come back); `screenshot`, `perform` 5 s;
  `type` 10 s; every other command 2 s.
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
