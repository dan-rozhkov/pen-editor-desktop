import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentPanelMenuLabel, defaultAgentPanelSettings, readAgentPanelSettings, writeAgentPanelSettings } from "../src/main/agentPanelSettings";

describe("agent panel settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-"));
  const file = path.join(dir, "sub", "agent-panel-settings.json");
  it("defaults to expanded for a missing, corrupt or mistyped file", () => {
    expect(readAgentPanelSettings(file)).toEqual(defaultAgentPanelSettings());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{nope");
    expect(readAgentPanelSettings(file).collapsed).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ collapsed: "yes" }));
    expect(readAgentPanelSettings(file).collapsed).toBe(false);
  });
  it("round-trips the collapsed state", () => {
    expect(writeAgentPanelSettings(file, { collapsed: true })).toBe(true);
    expect(readAgentPanelSettings(file)).toEqual({ collapsed: true });
  });
  it("labels the menu item by state", () => {
    expect(agentPanelMenuLabel(false)).toBe("Hide Agent Panel");
    expect(agentPanelMenuLabel(true)).toBe("Show Agent Panel");
  });
});
