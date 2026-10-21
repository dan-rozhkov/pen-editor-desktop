// Shortcuts the model may never send to a natively controlled app: they act on the app or the system, not on
// the app's content (quit, close window, hide, minimise, switch app or space, Spotlight, force quit, power).
// Pure and Electron-free. The model's text reaches the OS through the helper, so this runs BEFORE the helper call.

const MODIFIER_ALIASES: Readonly<Record<string, "meta" | "alt" | "control" | "shift">> = {
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  cmdorctrl: "meta",
  commandorcontrol: "meta",
  alt: "alt",
  option: "alt",
  opt: "alt",
  ctrl: "control",
  control: "control",
  shift: "shift",
};

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  spacebar: "space",
  " ": "space",
  grave: "`",
  backtick: "`",
  graveaccent: "`",
  missioncontrol: "missioncontrol",
  "mission control": "missioncontrol",
  mission_control: "missioncontrol",
  "mission-control": "missioncontrol",
  launchpad: "launchpad",
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
};

/** With Meta (Cmd), whatever the other modifiers: quit, close window, hide, minimise, app switcher, window switcher, Spotlight. */
const META_BLOCKED_KEYS: ReadonlySet<string> = new Set(["q", "w", "h", "m", "tab", "`", "space"]);
/** With any modifiers (or none): Mission Control, Launchpad, power keys. */
const ALWAYS_BLOCKED_KEYS: ReadonlySet<string> = new Set(["f3", "f4", "f11", "missioncontrol", "launchpad", "power", "eject"]);
/** With Control, whatever the other modifiers: switch Space / Mission Control / App Exposé. */
const CONTROL_ARROWS: ReadonlySet<string> = new Set(["arrowleft", "arrowright", "arrowup", "arrowdown"]);
/** Screenshot keys of the whole screen (may capture other apps); "#", "$", "%" are Shift+3/4/5 as characters. */
const SCREENSHOT_KEYS: ReadonlySet<string> = new Set(["3", "4", "5", "#", "$", "%"]);

interface Parsed {
  mods: Set<string>;
  key: string;
}

function parseCombo(combo: string, extraMods: readonly string[]): Parsed | null {
  // "Meta+ " ends in a space key; trimming would turn it into "Meta+" (Cmd and plus).
  const s = /\+\s+$/.test(combo) ? `${combo.replace(/\s+$/, "")}space` : combo.trim();
  if (s === "") return null;
  let parts: string[];
  if (s === "+") parts = ["+"];
  else if (s.endsWith("+")) parts = [...s.slice(0, -1).split("+").filter((p) => p !== ""), "+"];
  else parts = s.split("+");
  const mods = new Set<string>();
  for (const m of extraMods) {
    const a = MODIFIER_ALIASES[m.trim().toLowerCase()];
    if (a) mods.add(a);
  }
  const raw = parts[parts.length - 1].trim().toLowerCase();
  for (const p of parts.slice(0, -1)) {
    const a = MODIFIER_ALIASES[p.trim().toLowerCase()];
    if (a) mods.add(a);
  }
  // A lone modifier ("Meta") is no combination yet.
  if (MODIFIER_ALIASES[raw] && parts.length === 1) return null;
  const key = KEY_ALIASES[raw] ?? KEY_ALIASES[parts[parts.length - 1]] ?? raw;
  return { mods, key };
}

function blockedCombo(p: Parsed): boolean {
  if (ALWAYS_BLOCKED_KEYS.has(p.key)) return true;
  if (p.mods.has("meta") && META_BLOCKED_KEYS.has(p.key)) return true;
  if (p.mods.has("control") && p.key === "space") return true; // switch input source
  if (p.mods.has("meta") && p.mods.has("alt") && p.key === "escape") return true; // Force Quit
  if (p.mods.has("control") && CONTROL_ARROWS.has(p.key)) return true; // switch Space, Mission Control, App Exposé
  if (p.mods.has("control") && /^[0-9]$/.test(p.key)) return true; // switch to Space N
  if (p.mods.has("meta") && p.key === "f5") return true; // VoiceOver
  if (p.mods.has("meta") && p.mods.has("alt") && p.key === "d") return true; // hide or show the Dock
  if (p.mods.has("control") && p.mods.has("meta") && p.key === "f") return true; // full screen: moves the app to a new Space
  if (p.mods.has("meta") && p.mods.has("shift") && SCREENSHOT_KEYS.has(p.key)) return true; // screenshots of the whole screen
  return false;
}

/**
 * Whether `key` (a combination such as "Meta+q", "cmd+option+w", "Control+Space", or one key) with the extra
 * `modifiers` must be refused. Case, modifier order and aliases (Cmd/Command/Meta, Option/Alt, Ctrl/Control) do
 * not matter. A string of several combinations separated by spaces is blocked if any one is.
 */
export function isBlockedShortcut(key: string, modifiers: readonly string[] = []): boolean {
  if (typeof key !== "string") return false;
  const whole = parseCombo(key, modifiers);
  if (whole && blockedCombo(whole)) return true;
  const t = key.trim();
  if (/\s/.test(t)) {
    for (const piece of t.split(/\s+/)) {
      const p = parseCombo(piece, modifiers);
      if (p && blockedCombo(p)) return true;
    }
  }
  return false;
}
