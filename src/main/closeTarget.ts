/** What the global "Close Tab" menu item (Cmd/Ctrl+W) closes. */
export type CloseTarget = { kind: "tab"; id: number } | { kind: "none" };

export function decideCloseTarget(input: { activeTabId: number | null }): CloseTarget {
  if (input.activeTabId !== null) return { kind: "tab", id: input.activeTabId };
  // Nothing to close (zero tabs, or only background isolated-session tabs): a deliberate
  // no-op. Cmd/Ctrl+W never closes the window (macOS convention: that is "Close Window",
  // Cmd/Ctrl+Shift+W), so a stray extra press cannot lose the window or kill running QA sessions.
  return { kind: "none" };
}

/**
 * macOS `activate` (dock click) reopens a main window when none is left. Windows that are not
 * main windows (the agent cursor overlay) must not count: with only those left the app would
 * otherwise stay without an editor. `isOtherWindow` says which windows to ignore.
 */
export function shouldReopenMainWindow<T>(windows: readonly T[], isOtherWindow: (w: T) => boolean): boolean {
  return windows.every(isOtherWindow);
}
