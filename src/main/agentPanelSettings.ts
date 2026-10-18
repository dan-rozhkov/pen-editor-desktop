import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The user's agent-panel choice (agent layout): collapsed or not, persisted in
 * userData like cursor-settings.json. Pure file helpers (the caller passes the path).
 * A collapsed panel stays collapsed when the agent opens a canvas tab or a launch
 * arrives: only the user's toggle (button or View menu) changes it.
 */
export interface AgentPanelSettings {
  collapsed: boolean;
}

export const AGENT_PANEL_SETTINGS_FILE = "agent-panel-settings.json";

export function defaultAgentPanelSettings(): AgentPanelSettings {
  return { collapsed: false };
}

/** Missing/corrupt file or a wrong type -> expanded. */
export function readAgentPanelSettings(filePath: string): AgentPanelSettings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).collapsed === "boolean") {
      return { collapsed: (parsed as { collapsed: boolean }).collapsed };
    }
  } catch {
    // defaults
  }
  return defaultAgentPanelSettings();
}

/** Best effort: a failed write must never break the app; returns success. */
export function writeAgentPanelSettings(filePath: string, settings: AgentPanelSettings): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** View menu label for the toggle item. */
export function agentPanelMenuLabel(collapsed: boolean): string {
  return collapsed ? "Show Agent Panel" : "Hide Agent Panel";
}
