// Electron side of macOS computer use: builds the `ComputerUseDeps` that `openApp` takes (see
// appTargets.ts). Returns undefined when the helper is not available (not macOS, or no binary).
import { promises as fs } from "node:fs";
import { app, shell } from "electron";
import { bundleOf, type ComputerUseDeps } from "../appTargets";
import { appConfirm, validateRequestedApp } from "../appTargetsService";
import type { RunningApp } from "./appResolver";
import { computerUseAvailable, getHelper } from "./helper";

export { computerUseAvailable } from "./helper";

export function computerUseDeps(win: Electron.BaseWindow, owner: number): ComputerUseDeps | undefined {
  if (!computerUseAvailable()) return undefined;
  const helper = getHelper();
  return {
    async listApps() {
      const res = await helper.call("listApps");
      return Array.isArray(res.apps) ? (res.apps as RunningApp[]) : [];
    },
    async windowTitles(pid) {
      const res = await helper.call("windows", { pid });
      const ws = Array.isArray(res.windows) ? (res.windows as { title?: unknown }[]) : [];
      return ws.map((w) => (typeof w.title === "string" ? w.title : "")).filter((t) => t !== "");
    },
    realpath: (p) => fs.realpath(p),
    async permissions(prompt) {
      const res = await helper.call("permissions", prompt ? { prompt: true } : {});
      return { accessibility: res.accessibility === true, screenRecording: res.screenRecording === true };
    },
    openAccessibilitySettings() {
      void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").catch(() => undefined);
    },
    confirmAttach: (target) => appConfirm.confirmAttach(win, target, owner),
    ownBundlePath: bundleOf(app.getPath("exe")) ?? undefined,
    isRestartable: async (a) => a.bundlePath !== undefined && (await validateRequestedApp(a.bundlePath)).ok,
  };
}
