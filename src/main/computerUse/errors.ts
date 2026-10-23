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
  "Attached to the running app without a restart; the user's own session. Elements come from the macOS accessibility tree. Actions may bring the app to the front and briefly move the mouse pointer. QA checks work here as text checks, and as element or value checks with an index from browse_snapshot; checks with a selector and url checks do not. An absent or hidden check here means \"not visible in the window\"; scroll first if the content may be out of view. A native app has no console or network log, so no_console_errors and no_failed_requests always pass here and prove nothing: do not use them.";
export const ERR_NATIVE_SHORTCUT_BLOCKED = (key: string): string =>
  `The shortcut "${key}" is blocked because it could quit or switch the app. Use the app's own controls instead.`;
export const ERR_NATIVE_NOT_FRONTMOST = "The app did not come to the front, so no input was sent. Ask the user to bring it to the front.";
export const ERR_NATIVE_POINT_NOT_IN_APP = "The point is covered by another app's window, so no click was sent.";

/** Added to a snapshot result when the element list was cut at `max`. */
export const NATIVE_LIST_TRUNCATED_NOTE = (max: number, searchMax: number): string =>
  `The list stops at ${max} elements; elements lower in the window are not listed. browse_act with "target" also searches further, up to ${searchMax} elements, by label. To get a shorter list, type into the app's own search or filter field.`;
/** `what` is e.g. "url check" or "element check with a CSS selector". */
export const ERR_NATIVE_CHECK_UNSUPPORTED = (what: string): string =>
  `A ${what} is not available for an app controlled through macOS accessibility. Use a text check, or an element or value check with an index from browse_snapshot.`;
export const ERR_NATIVE_CHECK_NO_INDEX = (index: number | string): string =>
  `No element with index ${index} in the latest snapshot. Call browse_snapshot first.`;
export const ERR_NATIVE_CHECK_CUT =
  "The element list was cut, so the absence of the element cannot be proven. Use a text check, or take a new snapshot and check again.";
export const ERR_NATIVE_CHECK_AMBIGUOUS = (index: number, tag: string, label: string): string =>
  `Several elements match index ${index} (${tag}, ${label}); take a new snapshot and check again.`;
export const ERR_NATIVE_TEXT_ABSENT_CUT = "The window text was cut, so the absence of the text cannot be proven.";
export const ERR_NATIVE_CHECK_NO_CHECKED = "The element has no checked state.";
export const ERR_NATIVE_CHECK_NO_VALUE = "The element has no value.";
export const ERR_NATIVE_CHECK_NO_LABEL = (index: number): string =>
  `The element at index ${index} has no label, so it cannot be found again after the window changed. Check it with a text check, or take a new snapshot and check right after it.`;
export const ERR_NATIVE_CHECK_EMPTY_TEXT = "The text has no visible characters, so it cannot be checked.";
