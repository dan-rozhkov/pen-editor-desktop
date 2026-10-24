// Dependency-free on purpose: menu.ts imports it, and pen-editor's
// desktopMenuContract test builds the real menu template from menu.ts.
// Keeping it out of revealInFolder.ts stops that import chain from reaching
// traceStore → @sideform/browser-agent, which does not resolve there.

/** "Reveal in Finder" on macOS, "Show in Explorer" on Windows, "Show in Folder" elsewhere. */
export function revealMenuLabel(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Reveal in Finder";
  if (platform === "win32") return "Show in Explorer";
  return "Show in Folder";
}
