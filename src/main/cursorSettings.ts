import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_CURSOR_MOTION,
  isCursorMotionStyle,
  isEnvValueSet,
  resolveBrowserCursorEnabled,
  resolveBrowserCursorMotion,
  type CursorMotionStyle,
} from "./config";

/** The user's saved agent-cursor choices (menu: View > Agent Cursor Motion).
 * Env vars override these (see window.ts). Pure file helpers: the caller
 * passes the path, so tests can use a temp dir. */
export interface CursorSettings {
  motion: CursorMotionStyle;
  enabled: boolean;
}

export const CURSOR_SETTINGS_FILE = "cursor-settings.json";

export function defaultCursorSettings(): CursorSettings {
  return { motion: DEFAULT_CURSOR_MOTION, enabled: true };
}

/** Missing/corrupt file → defaults; each invalid field falls back alone. */
export function readCursorSettings(filePath: string): CursorSettings {
  const settings = defaultCursorSettings();
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const rec = parsed as Record<string, unknown>;
      if (isCursorMotionStyle(rec.motion)) settings.motion = rec.motion;
      if (typeof rec.enabled === "boolean") settings.enabled = rec.enabled;
    }
  } catch {
    // fall through to defaults
  }
  return settings;
}

/** Best effort: a failed write must never break the app; returns success. */
export function writeCursorSettings(filePath: string, settings: CursorSettings): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

export interface EffectiveCursorSettings extends CursorSettings {
  /** An env var decides `enabled`: the menu's checkbox renders disabled. */
  enabledLocked: boolean;
  /** An env var decides `motion`: the menu's radio items render disabled. */
  motionLocked: boolean;
}

/** Precedence: a (non-empty) env var wins and locks its menu items; empty or
 * whitespace-only counts as unset; an invalid env motion is ignored (the
 * saved choice applies, unlocked). Otherwise the saved settings apply. */
export function resolveCursorSettings(env: NodeJS.ProcessEnv, saved: CursorSettings): EffectiveCursorSettings {
  const enabledLocked = isEnvValueSet(env.PEN_DESKTOP_BROWSER_CURSOR);
  const envMotion = resolveBrowserCursorMotion(env);
  return {
    enabled: enabledLocked ? resolveBrowserCursorEnabled(env) : saved.enabled,
    motion: envMotion ?? saved.motion,
    enabledLocked,
    motionLocked: envMotion !== undefined,
  };
}
