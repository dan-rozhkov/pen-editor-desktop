// Deny-by-default permission policy for the built-in browser's dedicated
// "persist:penbrowser" session (design doc `2026-09-18-builtin-browser-design.md`
// §1). Electron grants permission requests by default, and this browser has
// no chrome (no address-bar padlock, no per-site settings UI) to ever
// reveal or revoke a granted permission, so any page the user browses to
// could otherwise silently pick up geolocation, notifications,
// clipboard-read, or media devices with no prompt at all (finding 6).
//
// Electron-free and injected, same style as mcp/dispatcher.ts and
// browser/controller.ts — `target` stands in for the real
// `Session` so this is unit-testable under plain Node/vitest.
// window.ts/index.ts wire the real `session.fromPartition("persist:penbrowser")`
// into it exactly once (not per tab — see index.ts).

export interface PermissionHandlerTarget {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: unknown,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (webContents: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean,
  ): void;
}

/** Denies every permission request and check outright, regardless of
 * permission type or requesting origin. */
export function denyAllPermissions(target: PermissionHandlerTarget): void {
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}
