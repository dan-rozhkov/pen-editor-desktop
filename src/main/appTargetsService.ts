// The app-wide desktop-app registry and confirm memory (see appTargets.ts for
// every decision). One instance for the whole process: the cap of running apps
// is global across windows. This file only wires Electron and the launcher.
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, dialog } from "electron";
import type { ElectronApp } from "@sideform/browser-agent/adapters/electron";
import { createAppConfirm, createAppRegistry, validateAppPath, type AppPathResult } from "./appTargets";

// What the registry holds: the launcher's app plus the profile dir WE own.
export interface LaunchedApp {
  controller: ElectronApp["controller"];
  pid: number;
  profileDir: string;
  onDisconnected(cb: () => void): void;
  close(): Promise<void>;
}

const rmProfile = (dir: string) => rmSync(dir, { recursive: true, force: true });

// Lazy: playwright-core is heavy and most sessions never launch an app.
// ESM-only subpath, loaded through require(esm) from this CommonJS build.
const launchApp = async (appPath: string): Promise<LaunchedApp> => {
  const mod = await import("@sideform/browser-agent/adapters/electron");
  // We own the profile dir (fresh, in the OS temp dir) so a synchronous quit can remove it.
  // Only the path from the model leaves here: no args, no env.
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "sideform-app-"));
  let launched: ElectronApp;
  try {
    launched = await mod.launchElectronApp({ app: appPath, userDataDir: profileDir });
  } catch (err) {
    rmProfile(profileDir);
    throw err;
  }
  let closing: Promise<void> | undefined;
  return {
    controller: launched.controller,
    pid: launched.pid,
    profileDir,
    onDisconnected: (cb) => launched.onDisconnected(cb),
    close: () => (closing ??= launched.close().finally(() => rmProfile(profileDir))),
  };
};

const signalPid = (pid: number, signal: NodeJS.Signals | 0): boolean => {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false; // ESRCH: already gone
  }
};

export const appRegistry = createAppRegistry<LaunchedApp>({
  launch: launchApp,
  isAlive: (h) => signalPid(h.pid, 0),
  killSync: (h) => {
    signalPid(h.pid, "SIGKILL");
    rmProfile(h.profileDir);
  },
});

export const appConfirm = createAppConfirm<Electron.BaseWindow>({
  showMessageBox: (win, options) => dialog.showMessageBox(win, options),
});

export const validateRequestedApp = (input: unknown): Promise<AppPathResult> =>
  validateAppPath(input, {
    realpath: (p) => fs.realpath(p),
    isDirectory: async (p) => (await fs.stat(p).catch(() => null))?.isDirectory() === true,
    homeDir: os.homedir(),
    ownExecutable: app.getPath("exe"),
    isPackaged: app.isPackaged,
    env: process.env,
  });
