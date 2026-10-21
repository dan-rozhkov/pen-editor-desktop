// The app-wide desktop-app registry and confirm memory (see appTargets.ts for
// every decision). One instance for the whole process: the cap of running apps
// is global across windows. This file only wires Electron and the launcher.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, dialog } from "electron";
import type { ElectronApp } from "@sideform/browser-agent/adapters/electron";
import type { AppController } from "./appTargets";
import { createCursorOverlay } from "./computerUse/cursorOverlay";
import { encodeImageForAgent, getHelper, nativeCursorEnabled } from "./computerUse/helper";
import { createNativeHandle } from "./computerUse/nativeHandle";
import type { RunningApp } from "./computerUse/appResolver";
import { createAppConfirm, createAppRegistry, filterUserPids, intersectWorkspacePids, killHandleSync, quitReopenShellArgs, ranAtRelease, validateAppPath, workspacePidsArgs, type AppPathResult, type LaunchOptions } from "./appTargets";

// What the registry holds: the launcher's app plus the profile dir WE own.
export interface LaunchedApp {
  controller: ElectronApp["controller"] | AppController;
  /** Undefined for a native (computer use) handle: the user's app, never signalled. */
  pid: number | undefined;
  /** Attached to the user's running app through macOS accessibility; close() only removes the overlay. */
  native?: boolean;
  /** Native handles only: remove the cursor overlay (the quit path). */
  destroyOverlay?(): void;
  /** Our temp profile dir; null when the app runs with the user's own profile. */
  profileDir: string | null;
  /** The real `.app` path (to open it again after a user-profile run). */
  appPath: string;
  userProfile: boolean;
  /** The CDP link already dropped (the user quit the app, or it crashed). */
  readonly disconnected: boolean;
  onDisconnected(cb: () => void): void;
  close(): Promise<void>;
}

type Adapter = typeof import("@sideform/browser-agent/adapters/electron");
let adapter: Adapter | undefined;
/** Lazy, and cached so the synchronous quit path can read it (an `await import` there could be cut off at exit). */
const loadAdapter = async (): Promise<Adapter> => (adapter ??= await import("@sideform/browser-agent/adapters/electron"));

const rmProfile = (dir: string | null) => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
};

const QUIT_ON_ASK_MS = 15_000;

const OPEN_BACKGROUND_ARGS = (appPath: string): string[] => ["-g", appPath];

/** Open the app again as normal, in the background (-g: do not steal focus). Never throws. */
export const reopenApp = (appPath: string): Promise<void> =>
  new Promise((resolve) => {
    execFile("open", OPEN_BACKGROUND_ARGS(appPath), (err) => {
      if (err) console.error("desktop app: reopen failed", err);
      resolve();
    });
  });

// Lazy: playwright-core is heavy and most sessions never launch an app.
// ESM-only subpath, loaded through require(esm) from this CommonJS build.
const launchNative = async (appPath: string, pid: number): Promise<LaunchedApp> => {
  const helper = getHelper();
  return await createNativeHandle({
    helper,
    pid,
    appPath,
    describe: async (p) => {
      const res = await helper.call("listApps");
      const apps = Array.isArray(res.apps) ? (res.apps as RunningApp[]) : [];
      return apps.find((a) => a.pid === p);
    },
    overlay: createCursorOverlay({ enabled: nativeCursorEnabled }),
    encodeImage: encodeImageForAgent,
  });
};

const launchApp = async (appPath: string, opts?: LaunchOptions): Promise<LaunchedApp> => {
  if (opts?.native) return await launchNative(appPath, opts.native.pid);
  const mod = await loadAdapter();
  const userProfile = opts?.userProfile === true;
  // Temp profile: we own the dir (fresh, in the OS temp dir) so a synchronous quit can remove it.
  // User profile: the app keeps its own data, nothing to remove.
  // Only the path from the model leaves here: no args, no env.
  const profileDir = userProfile ? null : mkdtempSync(path.join(os.tmpdir(), "sideform-app-"));
  let launched: ElectronApp;
  try {
    launched = await mod.launchElectronApp(userProfile ? { app: appPath, useAppProfile: true } : { app: appPath, userDataDir: profileDir! });
  } catch (err) {
    rmProfile(profileDir);
    throw err;
  }
  let closing: Promise<void> | undefined;
  let disconnected = false;
  launched.onDisconnected(() => {
    disconnected = true;
  });
  const release = async () => {
    // Reopen only an app that ran when the release began (not one the user quit or that crashed).
    // A dropped CDP link with a live process may be the user's Cmd+Q still finishing: see ranAtRelease.
    const wasAlive = await ranAtRelease({
      userProfile,
      disconnected,
      isAlive: () => signalPid(launched.pid, 0),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    try {
      // With the user's profile, close() disconnects and quits gracefully; it never kills.
      await launched.close();
    } finally {
      rmProfile(profileDir);
    }
    if (wasAlive) {
      // Gone: open it again. Still alive = a dialog keeps it open: a detached waiter reopens it once the user answers.
      if (!signalPid(launched.pid, 0)) await reopenApp(appPath);
      else reopenWhenGone(appPath, launched.pid);
    }
  };
  return {
    controller: launched.controller,
    pid: launched.pid,
    profileDir,
    appPath,
    userProfile,
    get disconnected() {
      return disconnected;
    },
    onDisconnected: (cb) => launched.onDisconnected(cb),
    close: () => (closing ??= release()),
  };
};

const signalPid = (pid: number | undefined, signal: NodeJS.Signals | 0): boolean => {
  if (pid === undefined || !(pid > 0)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false; // ESRCH: already gone
  }
};

// Detached /bin/sh helpers/waiters we spawned, per real path (removed on exit). A restart cancels them first:
// a stale waiter would `open -g` the app in the middle of it.
const helpers = new Map<string, Set<ChildProcess>>();

/** The JXA quit text for a pid; empty when the adapter is not loaded or the pid is invalid (the helper then only waits). */
const quitScriptFor = (pid: number): string => {
  try {
    return adapter?.macQuitScript(pid) ?? "";
  } catch {
    return "";
  }
};

/**
 * The one helper spawn. Detached and unref'd so it outlives Sideform. It optionally re-sends the quit
 * (`sendQuit`), waits up to 60 s for the pid to go, and opens the app only if it is gone. Never blocks, never kills.
 */
const spawnHelper = (appPath: string, pid: number, sendQuit: boolean): void => {
  try {
    const child = spawn("/bin/sh", quitReopenShellArgs(appPath, pid), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SIDEFORM_QUIT_JXA: sendQuit ? quitScriptFor(pid) : "" },
    });
    let set = helpers.get(appPath);
    if (!set) helpers.set(appPath, (set = new Set()));
    set.add(child);
    child.once("exit", () => {
      set.delete(child);
      if (set.size === 0 && helpers.get(appPath) === set) helpers.delete(appPath);
    });
    child.unref();
  } catch (err) {
    console.error("desktop app: quit helper failed", err);
  }
};

/** Quit path: re-sends the quit (harmless), waits for the pid to go, then opens the app. */
const quitReopenDetached = (appPath: string, pid: number): void => spawnHelper(appPath, pid, true);

/** A quit that timed out (save dialog): wait for the pid to go, then open the app. Sends no quit. */
export const reopenWhenGone = (appPath: string, pid: number): void => spawnHelper(appPath, pid, false);

/** Kill the helpers/waiters spawned for this bundle (our own shells, not the user's app). */
export const cancelWaiters = (appPath: string): void => {
  for (const child of [...(helpers.get(appPath) ?? [])]) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
};

/** Open the app again, detached, from the quit path (must not block). */
const reopenDetached = (appPath: string): void => {
  try {
    spawn("open", OPEN_BACKGROUND_ARGS(appPath), { detached: true, stdio: "ignore" }).unref();
  } catch (err) {
    console.error("desktop app: reopen failed", err);
  }
};

/** Pids of real GUI apps (NSWorkspace) whose bundle is `realPath`, as the script prints them. Rejects on failure. */
const workspaceOutput = (realPath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("osascript", workspacePidsArgs(realPath), { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/**
 * Pids of the user's own instances: default-profile main processes of the bundle, not launched by Sideform,
 * and a real GUI app (a helper or daemon process with the same bundle path does not count). If NSWorkspace
 * cannot be asked, the process list alone decides.
 */
export const findUserRunningPids = async (realPath: string): Promise<number[]> => {
  const mod = await loadAdapter();
  const fromPs = filterUserPids(await mod.findRunningElectronApp(realPath), appRegistry.livePids());
  if (fromPs.length === 0) return fromPs;
  try {
    return intersectWorkspacePids(fromPs, await workspaceOutput(realPath));
  } catch (err) {
    console.error("desktop app: NSWorkspace lookup failed, using the process list", err);
    return fromPs;
  }
};

export const quitUserApp = async (pid: number): Promise<boolean> => {
  const mod = await loadAdapter();
  return mod.quitElectronApp(pid, { timeoutMs: QUIT_ON_ASK_MS });
};

export const appRegistry = createAppRegistry<LaunchedApp>({
  launch: launchApp,
  isAlive: (h) => signalPid(h.pid, 0),
  killSync: (h) => {
    // A native handle is the user's own app: only the overlay goes (never kill / quit helpers).
    if (h.native === true || h.pid === undefined) return void h.destroyOverlay?.();
    killHandleSync({ ...h, pid: h.pid }, { kill: (pid) => void signalPid(pid, "SIGKILL"), rmProfile, spawnQuitReopen: quitReopenDetached });
  },
  reopenDetached,
  quitReopenDetached,
});

export const appConfirm = createAppConfirm<Electron.BaseWindow>({
  showMessageBox: (win, options) => dialog.showMessageBox(win, options),
});

/** CFBundleIdentifier through plutil (path as argv, never a shell). null on any error. */
const readBundleId = (realPath: string): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(realPath, "Contents/Info.plist")],
      { timeout: 3000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
    );
  });

export const validateRequestedApp = (input: unknown): Promise<AppPathResult> =>
  validateAppPath(input, {
    realpath: (p) => fs.realpath(p),
    isDirectory: async (p) => (await fs.stat(p).catch(() => null))?.isDirectory() === true,
    homeDir: os.homedir(),
    ownExecutable: app.getPath("exe"),
    isPackaged: app.isPackaged,
    env: process.env,
    readBundleId,
  });
