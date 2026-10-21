import type { WebPreferences } from "electron";

/**
 * The shared hardening for every view this shell creates: context isolation,
 * no Node, sandbox. `preload` is the only bridge a view gets (none for browser
 * tabs); `extra` adds e.g. a session `partition`.
 */
export function secureWebPreferences(
  preload?: string,
  extra: Pick<WebPreferences, "partition" | "additionalArguments"> = {},
): WebPreferences {
  return {
    ...(preload ? { preload } : {}),
    ...extra,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

/** The preload argument that tells `window.penDesktop.browser.nativeApps` / the panel's copy whether computer use works. The preloads hold the same literal. */
export const NATIVE_APPS_ARG = "--sideform-native-apps=1";

/** `additionalArguments` for a view whose preload exposes `browser`: the native-apps flag only when the helper is available. */
export const nativeAppsArguments = (available: boolean): string[] => (available ? [NATIVE_APPS_ARG] : []);
