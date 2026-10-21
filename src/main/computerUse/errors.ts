// Error texts of macOS computer use. Short, written for the model: they reach it
// as `{ error }` results. Electron-free.

export const ERR_NO_ACCESSIBILITY =
  "Sideform Desktop has no Accessibility permission. Ask the user to turn on Sideform Desktop in System Settings > Privacy & Security > Accessibility, then call browse_open with app again. Do not retry before the user confirms.";
export const ERR_NO_SCREEN_RECORDING =
  "Sideform Desktop has no Screen Recording permission, so it cannot take a screenshot of the app. browse_snapshot and browse_read still work. To get screenshots, the user must turn on Sideform Desktop in System Settings > Privacy & Security > Screen & System Audio Recording and restart Sideform Desktop.";
export const ERR_NATIVE_OPEN_LOCKED = "This app cannot open a URL. Navigation is locked: use browse_act on the app's own controls.";
export const ERR_NATIVE_TABS = "A native app has fixed windows. Use browse_tabs list or switch; close and new are not available.";
export const ERR_NATIVE_UNSUPPORTED = (name: string): string => `"${name}" is not available for an app controlled through macOS accessibility.`;
export const ERR_NATIVE_NO_CAPTURE = "This window cannot be captured as a screenshot. browse_snapshot and browse_read still work.";
export const ERR_NATIVE_NO_WINDOW = "The app has no open window. Ask the user to open one.";
export const ERR_HELPER_MISSING = "Computer use is not available in this build of Sideform Desktop.";

/** Added to the launch result of an attach to a running app (spec section 3.5). */
export const NATIVE_MODE_NOTE =
  "Attached to the running app without a restart; the user's own session. Elements come from the macOS accessibility tree. Actions may bring the app to the front and briefly move the mouse pointer.";
export const ERR_NATIVE_SHORTCUT_BLOCKED = (key: string): string =>
  `The shortcut "${key}" is blocked because it could quit or switch the app. Use the app's own controls instead.`;
export const ERR_NATIVE_NOT_FRONTMOST = "The app did not come to the front, so no input was sent. Ask the user to bring it to the front.";
export const ERR_NATIVE_POINT_NOT_IN_APP = "The point is covered by another app's window, so no click was sent.";
