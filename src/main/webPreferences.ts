import type { WebPreferences } from "electron";

/**
 * The shared hardening for every view this shell creates: context isolation,
 * no Node, sandbox. `preload` is the only bridge a view gets (none for browser
 * tabs); `extra` adds e.g. a session `partition`.
 */
export function secureWebPreferences(
  preload?: string,
  extra: Pick<WebPreferences, "partition"> = {},
): WebPreferences {
  return {
    ...(preload ? { preload } : {}),
    ...extra,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}
