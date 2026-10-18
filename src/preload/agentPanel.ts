import { contextBridge } from "electron";

// The agent panel's bridge. Deliberately empty for now: the panel is not an
// editor tab, so it gets no menu/MCP/browser:command access. Version only.
contextBridge.exposeInMainWorld("penAgentPanel", { version: 1 });
