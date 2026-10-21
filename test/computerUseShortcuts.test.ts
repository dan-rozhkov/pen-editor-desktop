import { describe, expect, it } from "vitest";
import { isBlockedShortcut } from "../src/main/computerUse/shortcuts";

describe("isBlockedShortcut", () => {
  it("blocks app and system shortcuts", () => {
    for (const k of [
      "Meta+q", "Meta+w", "Meta+Alt+w", "Meta+h", "Meta+Alt+h", "Meta+m", "Meta+Tab", "Meta+`", "Meta+Space",
      "Control+Space", "Control+Meta+q", "Meta+Alt+Escape", "Meta+Shift+q", "Meta+Alt+Shift+q",
      "Meta+Control+Power", "Meta+Control+Eject", "F3", "F4", "Control+F3", "Meta+F4", "Mission Control", "MissionControl",
    ]) {
      expect(isBlockedShortcut(k), k).toBe(true);
    }
  });

  it("blocks Space, Dock, VoiceOver, full screen and whole-screen screenshot keys", () => {
    for (const k of [
      "Control+ArrowLeft", "Control+ArrowRight", "Control+ArrowUp", "Control+ArrowDown", "ctrl+Left", "Control+Shift+ArrowLeft",
      "Control+Alt+ArrowUp", "Control+Meta+ArrowRight", "Control+1", "Control+2", "Control+9", "Meta+F5", "Meta+Alt+F5", "Meta+Alt+d",
      "Control+Meta+f", "F11", "Shift+F11", "Meta+F11", "Meta+Shift+3", "Meta+Shift+4", "Meta+Shift+5", "Meta+Control+Shift+3",
      "Meta+Control+Shift+4", "Meta+Control+Shift+5", "cmd+shift+4",
    ]) {
      expect(isBlockedShortcut(k), k).toBe(true);
    }
    expect(isBlockedShortcut("ArrowLeft", ["Control"])).toBe(true);
  });

  it("keeps editing, plain, Shift, Alt and Meta arrows allowed", () => {
    for (const k of [
      "ArrowLeft", "Shift+ArrowLeft", "Alt+ArrowLeft", "Meta+ArrowLeft", "Meta+Shift+ArrowRight", "Alt+Shift+ArrowDown", "Meta+ArrowUp",
      "1", "Meta+1", "F5", "Control+Meta+d", "Meta+d", "Alt+d", "Meta+Shift+z", "Meta+Shift+2", "Meta+3", "Shift+3",
      "Meta+a", "Meta+c", "Meta+v", "Meta+x", "Meta+z", "Meta+s", "Meta+f", "F10", "F12",
    ]) {
      expect(isBlockedShortcut(k), k).toBe(false);
    }
  });

  it("normalises case, modifier order and aliases", () => {
    for (const k of ["cmd+q", "COMMAND+Q", "Cmd+Option+W", "option+cmd+w", "Command+Alt+H", "ctrl+space", "CONTROL+SPACE", "Ctrl+Cmd+Q", "Cmd+Opt+Esc", "cmd+tab", "Cmd+Spacebar", "Cmd+grave", "Meta+ ", "cmd+Q "]) {
      expect(isBlockedShortcut(k), k).toBe(true);
    }
  });

  it("also reads the modifiers argument", () => {
    expect(isBlockedShortcut("q", ["Cmd"])).toBe(true);
    expect(isBlockedShortcut("Escape", ["Meta", "Option"])).toBe(true);
    expect(isBlockedShortcut("a", ["Cmd"])).toBe(false);
  });

  it("blocks any combination in a space separated sequence", () => {
    expect(isBlockedShortcut("Enter Meta+q")).toBe(true);
    expect(isBlockedShortcut("Tab Enter")).toBe(false);
  });

  it("allows ordinary keys and editing shortcuts", () => {
    for (const k of ["Enter", "Tab", "Escape", "Space", " ", "a", "Meta+a", "Meta+c", "Meta+v", "Meta+z", "Meta+Shift+z", "Meta+f", "Meta+s", "Meta+t", "ArrowDown", "Shift+Tab", "Meta+Alt+Escape2", "F2", "F5", "Control+a", "Alt+q", "Meta", "+", "Meta++", ""]) {
      expect(isBlockedShortcut(k), k).toBe(false);
    }
  });
});
