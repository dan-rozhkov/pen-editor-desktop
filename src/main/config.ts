// The frontend serves the showcase gallery at "/" and the editor itself at
// "/app" — the shell must open the editor, never the gallery. An explicit
// PEN_DESKTOP_URL override is used verbatim, so it has to carry "/app" too
// (see the `dev` script in package.json).
export const DEFAULT_EDITOR_URL = "https://pen-editor.onrender.com/app";

/** Editor URL: PEN_DESKTOP_URL override (http/https only), else production. */
export function resolveEditorUrl(env: NodeJS.ProcessEnv): string {
  const override = env.PEN_DESKTOP_URL;
  if (override) {
    try {
      const url = new URL(override);
      if (url.protocol === "http:" || url.protocol === "https:") return override;
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_EDITOR_URL;
}

/** The built-in browser's human-like cursor overlay (see BrowserController's
 * `moveCursor`) is on by default — it's what makes the agent driving the
 * browser tab visible to the user watching it. `PEN_DESKTOP_BROWSER_CURSOR`
 * is the kill switch, matched case-insensitively against "off"/"0"/"false";
 * anything else (including unset) leaves it on. */
export function resolveBrowserCursorEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.PEN_DESKTOP_BROWSER_CURSOR;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "off" && normalized !== "0" && normalized !== "false";
}

/** The agent cursor's motion styles (CURSOR_JS in browser/pageScripts.ts;
 * motion math derived from trycua/cua, MIT). `signature_arc` is the default. */
export const CURSOR_MOTION_STYLES = [
  "signature_arc",
  "spring_settle",
  "magnetic",
  "comet_swoop",
  "classic",
] as const;
export type CursorMotionStyle = (typeof CURSOR_MOTION_STYLES)[number];
export const DEFAULT_CURSOR_MOTION: CursorMotionStyle = "signature_arc";

export function isCursorMotionStyle(value: unknown): value is CursorMotionStyle {
  return typeof value === "string" && (CURSOR_MOTION_STYLES as readonly string[]).includes(value);
}

let warnedUnknownCursorMotion = false;
/** Test-only: lets a test observe the once-per-process warning again. */
export function resetCursorMotionWarningForTests(): void {
  warnedUnknownCursorMotion = false;
}

/** True when an env var carries a real value. Empty and whitespace-only
 * count as UNSET (so they neither lock a menu item nor override a saved
 * choice) — both cursor vars use this same rule. */
export function isEnvValueSet(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== "";
}

/** `PEN_DESKTOP_BROWSER_CURSOR_MOTION` picks the cursor's motion style.
 * Trimmed and lower-cased; unset, empty or whitespace-only → `undefined`
 * (not set). An unknown value also yields `undefined`: the env value is
 * ignored and the menu/saved setting applies. That case warns at most once
 * per process (macOS `activate` re-creates the window and would repeat it). */
export function resolveBrowserCursorMotion(env: NodeJS.ProcessEnv): CursorMotionStyle | undefined {
  const raw = env.PEN_DESKTOP_BROWSER_CURSOR_MOTION;
  if (!isEnvValueSet(raw)) return undefined;
  const normalized = (raw as string).trim().toLowerCase();
  if (isCursorMotionStyle(normalized)) return normalized;
  if (!warnedUnknownCursorMotion) {
    warnedUnknownCursorMotion = true;
    console.warn(
      `PEN_DESKTOP_BROWSER_CURSOR_MOTION="${raw}" is not a known style; the env value is ignored and the menu/saved setting applies. Allowed: ${CURSOR_MOTION_STYLES.join(", ")}.`,
    );
  }
  return undefined;
}

/** `PEN_DESKTOP_USER_DATA_DIR` overrides Electron's userData directory (read
 * in index.ts before `app.ready`). Used by e2e so every run gets a fresh dir
 * and a developer's saved cursor settings never leak in. Empty = unset. */
export function resolveUserDataDir(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.PEN_DESKTOP_USER_DATA_DIR;
  return isEnvValueSet(raw) ? (raw as string).trim() : undefined;
}
