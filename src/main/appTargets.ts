// External desktop apps the chat agent may launch and drive (`open` with
// `args.app`). Every decision lives here, Electron-free and unit-tested:
// path validation, the confirm policy, the registry (one app per sender+session
// key, one launch in flight per key, a global cap) and the command routing plan.
// window.ts only adapts Electron (dialog, launch, IPC) to these.
//
// The model's text is ONLY the path. It never becomes an argument, an env var or
// a profile dir: the adapter makes a fresh temp profile and locks navigation.
import path from "node:path";

export const MAX_RUNNING_APPS = 2;
/** Extra allowed roots (colon separated), honoured only in an unpackaged build (e2e). */
export const APP_ROOTS_ENV = "PEN_DESKTOP_APP_ROOTS";

export const ERR_APP_NOT_BUNDLE = "The app path must be a .app bundle.";
export const ERR_APP_NOT_FOUND = "The app was not found.";
export const ERR_APP_BAD_ROOT = "The app must be inside /Applications or ~/Applications.";
export const ERR_APP_NOT_ELECTRON = "The app is not an Electron app (no Electron Framework found).";
export const ERR_APP_OWN_BUNDLE = "The app is Sideform Desktop itself.";
export const ERR_APP_BLOCKED = "This app is blocked: the AI agent may not control password managers.";
export const ERR_APP_DENIED = "The user did not allow launching this app.";
export const ERR_APP_BUSY = "An app launch is already in progress for this chat.";
export const ERR_APP_CAP = `At most ${MAX_RUNNING_APPS} desktop apps can run at once. Release one first.`;
export const ERR_APP_RELEASED = "The app was released before it finished launching.";
export const ERR_APP_QUIT_ON_LAUNCH = "The app quit right after it launched.";
export const ERR_APP_PROFILE_BUSY = "The user's profile of this app is already in use by another chat.";
/** The app is open and did not quit in time (it may show a save dialog). */
export const errAppDidNotQuit = (name: string): string =>
  `"${name}" did not quit. It may be showing a dialog (for example about unsaved changes). Ask the user to close it, then try again.`;
/** Added to the launch result when the app runs with the user's own profile. */
export const USER_PROFILE_NOTE =
  "The app was already open. Sideform restarted it with the user's own profile: the windows show the user's real data. Change only what the task asks for.";

export interface AppPathDeps {
  /** fs.realpath; rejects when the path does not exist. */
  realpath(p: string): Promise<string>;
  /** Whether a directory exists (checked on the real path). */
  isDirectory(p: string): Promise<boolean>;
  homeDir: string;
  /** `app.getPath("exe")`: the running Sideform Desktop executable. */
  ownExecutable: string;
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  /** CFBundleIdentifier of the bundle; null when it cannot be read (then the app counts as normal risk). */
  readBundleId(realPath: string): Promise<string | null>;
}

export type AppRisk = "high" | "normal";
export type AppPathResult = { ok: true; realPath: string; name: string; risk: AppRisk } | { ok: false; error: string };

// Best effort, matched on the macOS bundle identifier (lowercased). Electron apps only:
// other apps are refused earlier. Not a complete list: a readable id missing here is normal risk.
/** Password managers: the agent may never launch or control these. */
export const BLOCKED_BUNDLE_IDS: ReadonlySet<string> = new Set(
  [
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.agilebits.onepassword-osx",
    "com.bitwarden.desktop",
    "com.dashlane.dashlanephonefinal",
    "com.dashlane.Dashlane",
    "com.keepersecurity.passwordmanager",
    "me.proton.pass.electron",
    "in.sinew.Enpass-Desktop",
    "com.nordsec.nordpass",
    "com.siber.roboform",
  ].map((id) => id.toLowerCase()),
);

/** Messengers, mail and crypto wallets: allowed, but with a stronger confirm. */
export const HIGH_RISK_BUNDLE_IDS: ReadonlySet<string> = new Set(
  [
    "com.tinyspeck.slackmacgap",
    "com.hnc.Discord",
    "com.hnc.DiscordPTB",
    "com.hnc.DiscordCanary",
    "org.whispersystems.signal-desktop",
    "desktop.WhatsApp", // the old Electron WhatsApp
    "im.riot.app",
    "com.microsoft.teams",
    "com.microsoft.teams2",
    "com.mailspring.mailspring",
    "com.electron.exodus",
    "com.ledger.live",
    "io.trezor.TrezorSuite",
    "ch.protonmail.desktop",
    "Mattermost.Desktop",
    "com.wearezeta.zclient.mac",
    "com.automattic.beeper.desktop",
    "chat.rocket",
    "org.ferdium.ferdium-app",
    "com.sindresorhus.caprine",
    "io.atomicwallet",
  ].map((id) => id.toLowerCase()),
);

const isInside = (child: string, root: string): boolean => {
  const rel = path.relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** The `.app` bundle containing an executable path, or null. */
export function bundleOf(exe: string): string | null {
  const m = /^(.*?\.app)(\/|$)/.exec(exe);
  return m ? m[1] : null;
}

export async function validateAppPath(input: unknown, deps: AppPathDeps): Promise<AppPathResult> {
  if (typeof input !== "string" || input.trim() === "" || input.includes("\0")) return { ok: false, error: ERR_APP_NOT_BUNDLE };
  if (!path.isAbsolute(input)) return { ok: false, error: ERR_APP_NOT_BUNDLE };
  let real: string;
  try {
    real = await deps.realpath(input);
  } catch {
    return { ok: false, error: ERR_APP_NOT_FOUND };
  }
  if (!real.endsWith(".app")) return { ok: false, error: ERR_APP_NOT_BUNDLE };
  const roots = ["/Applications", path.join(deps.homeDir, "Applications")];
  if (!deps.isPackaged) {
    for (const r of (deps.env[APP_ROOTS_ENV] ?? "").split(":")) if (r.trim() !== "") roots.push(r.trim());
  }
  // Roots are realpath'd too (/Users can be a symlink on some setups); a root that does not exist is skipped.
  const realRoots: string[] = [];
  for (const r of roots) {
    try {
      realRoots.push(await deps.realpath(r));
    } catch {
      /* missing root */
    }
  }
  if (!realRoots.some((r) => isInside(real, r))) return { ok: false, error: ERR_APP_BAD_ROOT };
  if (!(await deps.isDirectory(path.join(real, "Contents/Frameworks/Electron Framework.framework")))) {
    return { ok: false, error: ERR_APP_NOT_ELECTRON };
  }
  let id: string | null;
  try {
    id = await deps.readBundleId(real);
  } catch {
    id = null;
  }
  const bundleId = id?.trim().toLowerCase() || null;
  if (bundleId !== null && BLOCKED_BUNDLE_IDS.has(bundleId)) return { ok: false, error: ERR_APP_BLOCKED };
  const own = bundleOf(deps.ownExecutable);
  if (own !== null) {
    let ownReal = own;
    try {
      ownReal = await deps.realpath(own);
    } catch {
      /* keep the unresolved path */
    }
    if (ownReal === real) return { ok: false, error: ERR_APP_OWN_BUNDLE };
  }
  // Fail open to the stricter dialog: an unreadable id is high risk (not blocked: we cannot know).
  const risk: AppRisk = bundleId === null || HIGH_RISK_BUNDLE_IDS.has(bundleId) ? "high" : "normal";
  return { ok: true, realPath: real, name: path.basename(real, ".app"), risk };
}

// ------------------------------------------------------------ user's own app

/**
 * Only default-profile instances count as "the user's app" (`userDataDir === null`): that leaves out
 * Sideform's own temp-profile instances (even ones still launching) and a user's second-profile
 * instance. Pids in `livePids` (apps this process spawned) are excluded too.
 */
export function filterUserPids(results: { pid: number; userDataDir: string | null }[], livePids: readonly number[]): number[] {
  const ours = new Set(livePids);
  return results.filter((r) => r.userDataDir === null && !ours.has(r.pid)).map((r) => r.pid);
}

/**
 * JXA run through `osascript -l JavaScript -e <script> <realPath>`: the pids of the NSWorkspace running
 * applications (real GUI apps) whose bundle path equals `argv[0]`, comma separated. The path is an argv
 * entry, never part of the script text.
 */
export const WORKSPACE_PIDS_JXA =
  "function run(argv){ ObjC.import('AppKit'); var apps=$.NSWorkspace.sharedWorkspace.runningApplications; var out=[]; " +
  "for (var i=0;i<apps.count;i++){ var a=apps.objectAtIndex(i); var u=a.bundleURL; " +
  "if(!u.isNil() && ObjC.unwrap(u.path)===argv[0]) out.push(a.processIdentifier);} return out.join(','); }";

/** argv for `osascript` that lists the GUI-app pids of one bundle. */
export const workspacePidsArgs = (realPath: string): string[] => ["-l", "JavaScript", "-e", WORKSPACE_PIDS_JXA, realPath];

/** Parse the script output ("123,456" or empty) into pids; anything that is not a positive integer is dropped. */
export function parseWorkspacePids(out: string): number[] {
  return out
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^\d+$/.test(t))
    .map(Number)
    .filter((n) => n > 0);
}

/** "The user's app" = a default-profile process (`psPids`) that is also a real GUI app of the bundle (`workspaceOut`). */
export function intersectWorkspacePids(psPids: readonly number[], workspaceOut: string): number[] {
  const gui = new Set(parseWorkspacePids(workspaceOut));
  return psPids.filter((p) => gui.has(p));
}

/**
 * Shell script for the detached quit-then-reopen helper. The JXA quit script comes in through the
 * `SIDEFORM_QUIT_JXA` env var; the app path ($1) and the pid ($2) are positional args. Nothing is
 * interpolated into the text. It reopens only when the process is really gone (a save dialog keeps it alive).
 * An empty `SIDEFORM_QUIT_JXA` skips the quit step: the helper is then a pure "wait until the pid is
 * gone (60 s), then open -g" waiter.
 */
export const QUIT_REOPEN_SCRIPT = [
  '[ -n "$SIDEFORM_QUIT_JXA" ] && osascript -l JavaScript -e "$SIDEFORM_QUIT_JXA" >/dev/null 2>&1',
  "i=0",
  'while [ "$i" -lt 120 ]; do',
  '  if ! kill -0 "$2" 2>/dev/null; then open -g "$1"; exit 0; fi',
  "  sleep 0.5",
  "  i=$((i+1))",
  "done",
].join("\n");

/** argv for `/bin/sh`: `-c <script> sh <realPath> <pid>`. */
export const quitReopenShellArgs = (realPath: string, pid: number): string[] => ["-c", QUIT_REOPEN_SCRIPT, "sh", realPath, String(pid)];

/**
 * Did the user's-profile app still run when the release began (so it should be reopened afterwards)?
 * The CDP link can drop before the process exits when the USER quits the app (Cmd+Q): if the link was
 * already down at release time, give the process `graceMs` to exit; if it does, the user quit it and it
 * must not be reopened. Still alive after that: treat it as running (graceful quit + reopen).
 */
export async function ranAtRelease(deps: {
  userProfile: boolean;
  /** onDisconnected already fired when the release started. */
  disconnected: boolean;
  isAlive(): boolean;
  sleep(ms: number): Promise<void>;
  graceMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  if (!deps.userProfile || !deps.isAlive()) return false;
  if (!deps.disconnected) return true;
  const grace = deps.graceMs ?? 3000;
  const poll = deps.pollMs ?? 100;
  for (let waited = 0; waited < grace; waited += poll) {
    await deps.sleep(poll);
    if (!deps.isAlive()) return false;
  }
  return true;
}

/** Quit path, per handle: a temp-profile app is killed and its profile removed; a user-profile app gets the detached helper (nothing blocks, nothing is killed). */
export function killHandleSync(
  h: { pid: number; profileDir: string | null; appPath: string; userProfile: boolean; disconnected?: boolean },
  deps: { kill(pid: number): void; rmProfile(dir: string | null): void; spawnQuitReopen(realPath: string, pid: number): void },
): void {
  if (h.userProfile) {
    // The link already dropped: the user quit the app (or it crashed). Do not reopen what the user closed.
    if (h.disconnected === true) return;
    return deps.spawnQuitReopen(h.appPath, h.pid);
  }
  deps.kill(h.pid);
  deps.rmProfile(h.profileDir);
}

// ------------------------------------------------------------------ confirm

export const APP_CONFIRM_BUTTONS = ["Allow once", "Allow until Sideform quits", "Don't allow"] as const;
/** High-risk apps: no "until Sideform quits", so every launch asks. */
export const APP_CONFIRM_HIGH_RISK_BUTTONS = ["Allow once", "Don't allow"] as const;
export const APP_RESTART_BUTTONS = ["Restart and allow", "Don't allow"] as const;
export const APP_HIGH_RISK_WARNING =
  "This app is high risk: it can hold private messages, mail or money. If you sign in to it, the agent can read and act in your name.";
export const appRestartMessage = (name: string): string => `"${name}" is open. Restart it so the AI agent can control it?`;
export const appRestartDetail = (realPath: string, risk: AppRisk = "normal"): string =>
  `${realPath}\n\n` +
  (risk === "high" ? `${APP_HIGH_RISK_WARNING}\n\n` : "") +
  "Sideform quits the app the way Cmd+Q does and opens it again with agent access. " +
  "It opens with your own profile (your logins, projects and settings), so the agent sees and can change your real data. " +
  "Unsaved work in the app can be lost. When the agent finishes, Sideform quits the app and opens it again as normal.\n\n" +
  "The app runs with your user rights, not in a sandbox: it can reach your files, run commands, and may use saved credentials such as keychain items. " +
  "Allow it only if you trust this app.";

export interface AppConfirmDeps<W> {
  showMessageBox(win: W, options: {
    type: "question";
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: boolean;
  }): Promise<{ response: number }>;
}

/**
 * Native confirm. "Until quits" is remembered in memory per real path AND per
 * owner (the sender that asked: a new chat or a reloaded panel asks again).
 * Never persisted.
 */
export function createAppConfirm<W>(deps: AppConfirmDeps<W>) {
  const remembered = new Set<string>();
  const memo = (owner: number, realPath: string) => `${owner}\0${realPath}`;
  return {
    async confirm(win: W, app: { name: string; realPath: string; risk?: AppRisk }, owner: number): Promise<boolean> {
      const high = app.risk === "high";
      if (!high && remembered.has(memo(owner, app.realPath))) return true;
      const { response } = await deps.showMessageBox(win, {
        type: "question",
        message: `Let the AI agent launch and control "${app.name}"?`,
        detail:
          `${app.realPath}\n\n` +
          (high ? `${APP_HIGH_RISK_WARNING}\n\n` : "") +
          "The app runs with your user rights, not in a sandbox: it can reach your files, run commands, and may use saved credentials such as keychain items. " +
          "It starts with a fresh profile, but that does not limit what it can do. The agent will see and click inside its windows. Allow it only if you trust this app.",
        buttons: high ? [...APP_CONFIRM_HIGH_RISK_BUTTONS] : [...APP_CONFIRM_BUTTONS],
        defaultId: high ? 1 : 2,
        cancelId: high ? 1 : 2,
        noLink: true,
      });
      if (high) return response === 0;
      if (response === 0) return true;
      if (response === 1) {
        remembered.add(memo(owner, app.realPath));
        return true;
      }
      return false;
    },
    /** The app is already open: always asked, never remembered, and "until quits" does not skip it. */
    async confirmRestart(win: W, app: { name: string; realPath: string; risk?: AppRisk }): Promise<boolean> {
      const { response } = await deps.showMessageBox(win, {
        type: "question",
        message: appRestartMessage(app.name),
        detail: appRestartDetail(app.realPath, app.risk),
        buttons: [...APP_RESTART_BUTTONS],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return response === 0;
    },
    /** The owner went away (reload, crash, close): its "until quits" answers go with it. */
    forgetSender(owner: number): void {
      for (const k of [...remembered]) if (k.startsWith(`${owner}\0`)) remembered.delete(k);
    },
  };
}

// ----------------------------------------------------------------- registry

/** The slice of a launched app the registry uses (the service's wrapper around `ElectronApp`). */
export interface AppHandle {
  /** The main process id, when known (lets the service tell its own apps from the user's). */
  pid?: number;
  /** The real `.app` path (set by the service). */
  appPath?: string;
  /** Runs with the user's own profile. */
  userProfile?: boolean;
  /** The CDP link already dropped (the user quit the app, or it crashed). */
  readonly disconnected?: boolean;
  onDisconnected(cb: () => void): void;
  close(): Promise<void>;
}

export const appKey = (senderId: number, sessionId: string | undefined): string => `${senderId}:${sessionId ?? ""}`;

export interface LaunchOptions {
  /** Run with the app's own (the user's) profile instead of a fresh temp one. */
  userProfile?: boolean;
}

export type LaunchOutcome<H> = { ok: true; handle: H } | { ok: false; error: string };
/** none: no binding; pending: an open is validating/confirming/launching; running; gone: it quit (sticky until released). */
export type AppState = "none" | "pending" | "running" | "gone";

export interface LaunchTicket<H> {
  /** True once a release point cancelled this open. */
  readonly cancelled: boolean;
  /** Launch under the still-live key; closes the previous app of the key only after the new one is up. */
  launch(appPath: string, opts?: LaunchOptions): Promise<LaunchOutcome<H>>;
  /**
   * Record that this flight is quitting the user's app at `realPath` (call it BEFORE sending the quit:
   * the terminate may already be in flight when Sideform quits). With a `pid`, a Sideform quit before the
   * launch is live spawns the detached quit-then-reopen helper for that pid; without, a bare reopen.
   */
  markUserAppQuit(realPath: string, pid?: number): void;
  /** Forget the mark for one pid (its quit timed out and a waiter owns the reopen now). No pids left = no mark. */
  unmarkUserAppQuit(realPath: string, pid: number): void;
  /** Another key holds the user-profile lock of `realPath`. */
  userProfileHeldElsewhere(realPath: string): boolean;
  /**
   * Take the user-profile lock of `realPath` for this key (true), or false when another key holds it. Held
   * until the flight ends without a live user-profile handle, or until that handle's close has finished.
   */
  lockUserProfile(realPath: string): boolean;
  /** Drop the reservation (idempotent; a no-op after launch). */
  abort(): void;
}

export function createAppRegistry<H extends AppHandle>(deps: {
  launch(appPath: string, opts?: LaunchOptions): Promise<H>;
  maxApps?: number;
  /** Synchronous per-handle quit handling (`killAllSync`): SIGKILL + profile removal for temp-profile apps, a detached helper for user-profile apps. */
  killSync?(handle: H): void;
  /** Spawns a detached `open -g <realPath>` (quit path; must not block). */
  reopenDetached?(realPath: string): void;
  /** Spawns the detached helper for a marked flight: re-sends the quit to `pid`, waits until it is gone, then reopens. */
  quitReopenDetached?(realPath: string, pid: number): void;
  /** Whether the app process still runs (checked right after launch). */
  isAlive?(handle: H): boolean;
}) {
  const max = deps.maxApps ?? MAX_RUNNING_APPS;
  type Binding = { handle: H } | { gone: true };
  type Flight = {
    cancelled: boolean;
    spawned: boolean;
    userAppQuit?: { realPath: string; pids: number[] };
    /** The user-profile lock this flight holds one reference to. */
    lock?: { realPath: string; lock: ProfileLock };
  };
  // realPath -> the key that owns the user's profile of that bundle. Reference counted: the flight and the
  // live handle each hold one (a relaunch by the same key overlaps the old handle's close).
  type ProfileLock = { key: string; refs: number };
  const profileLocks = new Map<string, ProfileLock>();
  const handleLocks = new Map<H, { realPath: string; lock: ProfileLock }>();
  const takeLock = (realPath: string, key: string): ProfileLock | null => {
    const cur = profileLocks.get(realPath);
    if (cur && cur.key !== key) return null;
    const lock = cur ?? { key, refs: 0 };
    lock.refs++;
    profileLocks.set(realPath, lock);
    return lock;
  };
  const dropLock = (realPath: string, lock: ProfileLock) => {
    if (--lock.refs <= 0 && profileLocks.get(realPath) === lock) profileLocks.delete(realPath);
  };
  const bindings = new Map<string, Binding>();
  // A flight stays here until its validate/confirm/launch/close fully finished, cancelled or not.
  const pending = new Map<string, Flight>();
  // Every handle that is spawned and not yet fully closed (running, replaced, or cancelled).
  const live = new Set<H>();
  const closing = new Map<H, Promise<void>>();

  const closeQuietly = (h: H): Promise<void> => {
    let p = closing.get(h);
    if (!p) {
      p = h
        .close()
        .catch((err) => console.error("desktop app: close failed", err))
        .finally(() => {
          live.delete(h);
          // The user-profile lock goes only now: the close (and the reopen it may do) has fully finished.
          const l = handleLocks.get(h);
          if (l) {
            handleLocks.delete(h);
            dropLock(l.realPath, l.lock);
          }
        });
      closing.set(h, p);
    }
    return p;
  };
  const boundHandle = (key: string): H | undefined => {
    const b = bindings.get(key);
    return b && "handle" in b ? b.handle : undefined;
  };

  const release = async (key: string): Promise<{ pending: boolean }> => {
    const flight = pending.get(key);
    const wasPending = flight !== undefined && !flight.cancelled;
    if (flight) flight.cancelled = true; // the entry stays until the flight finishes
    const handle = boundHandle(key);
    bindings.delete(key);
    if (handle) await closeQuietly(handle);
    return { pending: wasPending };
  };

  const releaseWhere = async (pred: (key: string) => boolean): Promise<void> => {
    const keys = new Set([...bindings.keys(), ...pending.keys()]);
    await Promise.all([...keys].filter(pred).map(release));
  };

  return {
    state(key: string): AppState {
      if (pending.has(key)) return "pending";
      const b = bindings.get(key);
      return b === undefined ? "none" : "handle" in b ? "running" : "gone";
    },
    get: boundHandle,
    /** Pids of every spawned app not fully closed (the service excludes them from "the user's apps"). */
    livePids(): number[] {
      return [...live].map((h) => h.pid).filter((p): p is number => typeof p === "number" && p > 0);
    },
    /** Spawned apps not fully closed, plus flights that have not spawned yet. */
    size(): number {
      return live.size + [...pending.values()].filter((f) => !f.spawned).length;
    },
    /** Step one of an app open: reserve the key before validate/confirm. */
    begin(key: string): { ok: true; ticket: LaunchTicket<H> } | { ok: false; error: string } {
      if (pending.has(key)) return { ok: false, error: ERR_APP_BUSY };
      // A relaunch replaces the key's own app, so that one is not counted.
      const own = boundHandle(key);
      const others = [...live].filter((h) => h !== own).length + [...pending.values()].filter((f) => !f.spawned).length;
      if (others >= max) return { ok: false, error: ERR_APP_CAP };
      const flight: Flight = { cancelled: false, spawned: false };
      pending.set(key, flight);
      const dropFlightLock = () => {
        if (flight.lock) {
          const { realPath, lock } = flight.lock;
          flight.lock = undefined;
          dropLock(realPath, lock);
        }
      };
      const finish = () => {
        if (pending.get(key) === flight) pending.delete(key);
        dropFlightLock();
      };
      const ticket: LaunchTicket<H> = {
        get cancelled() {
          return flight.cancelled;
        },
        abort: finish,
        markUserAppQuit(realPath, pid) {
          const cur = flight.userAppQuit?.realPath === realPath ? flight.userAppQuit : { realPath, pids: [] };
          if (pid !== undefined && !cur.pids.includes(pid)) cur.pids.push(pid);
          flight.userAppQuit = cur;
        },
        unmarkUserAppQuit(realPath, pid) {
          const cur = flight.userAppQuit;
          if (!cur || cur.realPath !== realPath) return;
          cur.pids = cur.pids.filter((p) => p !== pid);
          if (cur.pids.length === 0) flight.userAppQuit = undefined;
        },
        userProfileHeldElsewhere(realPath) {
          const cur = profileLocks.get(realPath);
          return cur !== undefined && cur.key !== key;
        },
        lockUserProfile(realPath) {
          if (flight.lock?.realPath === realPath) return true;
          if (flight.cancelled) return false;
          const lock = takeLock(realPath, key);
          if (!lock) return false;
          dropFlightLock();
          flight.lock = { realPath, lock };
          return true;
        },
        async launch(appPath, opts) {
          if (flight.cancelled) return { ok: false, error: ERR_APP_RELEASED };
          if (opts?.userProfile && flight.lock?.realPath !== appPath && !ticket.lockUserProfile(appPath)) {
            return { ok: false, error: ERR_APP_PROFILE_BUSY };
          }
          let succeeded = false;
          try {
            let handle: H;
            try {
              handle = await deps.launch(appPath, opts);
            } catch (err) {
              return { ok: false, error: err instanceof Error ? err.message : "Could not launch the app." };
            }
            flight.spawned = true;
            live.add(handle);
            if (opts?.userProfile && flight.lock) {
              flight.lock.lock.refs++; // the handle's own reference, dropped when its close has finished
              handleLocks.set(handle, { realPath: flight.lock.realPath, lock: flight.lock.lock });
            }
            // Subscribe at once; a quit before binding is caught by the checks below.
            let quit = false;
            handle.onDisconnected(() => {
              quit = true;
              if (boundHandle(key) === handle) bindings.set(key, { gone: true });
              void closeQuietly(handle);
            });
            if (flight.cancelled) {
              await closeQuietly(handle);
              return { ok: false, error: ERR_APP_RELEASED };
            }
            if (quit || (deps.isAlive && !deps.isAlive(handle))) {
              bindings.set(key, { gone: true });
              await closeQuietly(handle);
              return { ok: false, error: ERR_APP_QUIT_ON_LAUNCH };
            }
            const previous = boundHandle(key);
            bindings.set(key, { handle });
            if (previous) await closeQuietly(previous);
            // Re-check after the await: a release or a quit may have run meanwhile.
            if (boundHandle(key) !== handle) {
              await closeQuietly(handle);
              return { ok: false, error: flight.cancelled ? ERR_APP_RELEASED : ERR_APP_QUIT_ON_LAUNCH };
            }
            succeeded = true;
            return { ok: true, handle };
          } finally {
            // A failed launch keeps the flight's lock: openApp may still have to put the user's app back.
            if (succeeded) finish();
            else if (pending.get(key) === flight) pending.delete(key);
          }
        },
      };
      return { ok: true, ticket };
    },
    release,
    releaseWhere,
    releaseAll: (): Promise<void> => releaseWhere(() => true),
    /**
     * Quit path, synchronous and non-blocking (an async close would be cut off at exit).
     * Per spawned app, `killSync` decides: a temp-profile app is SIGKILLed and its profile removed;
     * a user-profile app gets a detached quit-then-reopen helper, so nothing blocks and nothing
     * of the user's is killed. A flight that is quitting (or quit) the user's app but has no live handle yet
     * (the gap before the relaunch is up) gets the detached helper for its pid, so the reopen waits until
     * the original app is really gone (a bare `open -g` when no pid was recorded).
     */
    killAllSync(): void {
      for (const flight of pending.values()) {
        flight.cancelled = true;
        if (flight.userAppQuit !== undefined && !flight.spawned) {
          const { realPath, pids } = flight.userAppQuit;
          try {
            if (pids.length > 0 && deps.quitReopenDetached) for (const pid of pids) deps.quitReopenDetached(realPath, pid);
            else deps.reopenDetached?.(realPath);
          } catch (err) {
            console.error("desktop app: reopen failed", err);
          }
          flight.userAppQuit = undefined;
        }
      }
      for (const h of live) {
        try {
          deps.killSync?.(h);
        } catch (err) {
          console.error("desktop app: kill failed", err);
        }
      }
      bindings.clear();
    },
  };
}

export type AppRegistry<H extends AppHandle> = ReturnType<typeof createAppRegistry<H>>;

/** Predicate for "everything this sender owns" (any session). */
export const ownedBySender = (senderId: number) => (key: string): boolean => key.startsWith(`${senderId}:`);
/** Predicate for one session of one sender. */
export const ownedBySession = (senderId: number, sessionId: string) => (key: string): boolean => key === appKey(senderId, sessionId);

// ------------------------------------------------------------------ routing

export type AppCommandPlan = "launch" | "route" | "refuse" | "release" | "passthrough" | "pending" | "gone";

const ROUTED = new Set(["open", "act", "snapshot", "read", "screenshot", "tabs", "findImages", "perform", "assert"]);
const REFUSED = new Set(["capture", "applyFixture", "fillLogin", "startJournal", "captureCheckpoint"]);

export const ERR_APP_COMMAND_UNSUPPORTED =
  "This command is only available in the built-in browser, not in a desktop app.";
export const ERR_APP_ARG = "open needs a non-empty string `app` path.";
export const ERR_APP_GONE = "The desktop app is no longer running. Call browse_open with app again, or end the run.";
export const ERR_APP_PENDING = "The desktop app is still starting (waiting for the user's confirmation or the launch). Wait, then retry.";

/**
 * Which path a `browser:command` takes given the key's app state. A key that
 * ever launched an app stays bound (`gone` included) until `releaseApp` or a
 * session/owner release, so a quit app never silently falls back to the
 * built-in browser.
 */
export function planAppCommand(command: string, args: unknown, state: AppState): AppCommandPlan {
  if (command === "releaseApp") return "release";
  if (command === "open" && typeof args === "object" && args !== null && Object.hasOwn(args, "app")) {
    const app = (args as { app?: unknown }).app;
    return typeof app === "string" && app.trim() !== "" ? "launch" : "refuse";
  }
  if (state === "none") return "passthrough";
  if (ROUTED.has(command)) return state === "pending" ? "pending" : state === "gone" ? "gone" : "route";
  if (REFUSED.has(command)) return "refuse";
  return "passthrough";
}

export function refusalFor(command: string, args: unknown): string {
  if (command === "open" && typeof args === "object" && args !== null && Object.hasOwn(args, "app")) return ERR_APP_ARG;
  return ERR_APP_COMMAND_UNSUPPORTED;
}

/** The error reply for a plan that does not reach the app. */
export function errorForPlan(plan: "refuse" | "pending" | "gone", command: string, args: unknown): { error: string } {
  if (plan === "pending") return { error: ERR_APP_PENDING };
  if (plan === "gone") return { error: ERR_APP_GONE };
  return { error: refusalFor(command, args) };
}

/** The controller methods an app command can reach (`BrowserController` satisfies it). */
export interface AppController {
  open(args: unknown): Promise<unknown>;
  act(args: unknown): Promise<unknown>;
  findImages(args: unknown): Promise<unknown>;
  snapshot(): Promise<unknown>;
  perform(args: unknown): Promise<unknown>;
  assert(args: unknown): Promise<unknown>;
  read(args: unknown): Promise<unknown>;
  screenshot(args: unknown): Promise<unknown>;
  tabs(args: unknown): Promise<unknown>;
}

/** The one routing table: command name to controller method. */
export const APP_ROUTES: Record<string, (c: AppController, args: unknown) => Promise<unknown>> = {
  open: (c, a) => c.open(a),
  act: (c, a) => c.act(a),
  findImages: (c, a) => c.findImages(a),
  snapshot: (c) => c.snapshot(),
  perform: (c, a) => c.perform(a),
  assert: (c, a) => c.assert(a),
  read: (c, a) => c.read(a),
  screenshot: (c, a) => c.screenshot(a),
  tabs: (c, a) => c.tabs(a),
};

export function routeAppCommand(c: AppController, command: string, args: unknown): Promise<unknown> {
  const route = Object.hasOwn(APP_ROUTES, command) ? APP_ROUTES[command] : undefined;
  return route ? route(c, args) : Promise.resolve({ error: refusalFor(command, args) });
}

/** A normal-open-shaped result from a tabs listing. */
export function shapeLaunchResult(listed: unknown, name: string, opts: LaunchOptions = {}): Record<string, unknown> {
  const l = typeof listed === "object" && listed !== null ? (listed as { tabs?: { url?: string; title?: string; current?: boolean }[] }) : {};
  const current = l.tabs?.find((t) => t.current) ?? l.tabs?.[0];
  const base = { ...l, url: current?.url ?? "", title: current?.title ?? "", app: name };
  return opts.userProfile ? { ...base, profile: "user", note: USER_PROFILE_NOTE } : base;
}

/** The whole app open: reserve, validate, confirm, launch. Never throws. */
export async function openApp<H extends AppHandle & { controller: Pick<AppController, "tabs"> }>(
  key: string,
  requested: unknown,
  deps: {
    registry: Pick<AppRegistry<H>, "begin" | "get">;
    validate(input: unknown): Promise<AppPathResult>;
    confirm(app: { name: string; realPath: string; risk?: AppRisk }): Promise<boolean>;
    /** Pids of the user's own running instances of the bundle (apps Sideform launched excluded). */
    findRunning(realPath: string): Promise<number[]>;
    /** The "already open, restart it?" confirm. Always shown. */
    confirmRestart(app: { name: string; realPath: string; risk?: AppRisk }): Promise<boolean>;
    /** Graceful quit like Cmd+Q; true = gone, false = still running. */
    quit(pid: number): Promise<boolean>;
    /** Open the app again normally, in the background. */
    reopen(realPath: string): Promise<void>;
    /** Detached waiter: once `pid` is gone, open the app again (no quit is sent). For a quit that timed out. */
    reopenWhenGone?(realPath: string, pid: number): void;
    /** Kill the detached waiters/helpers earlier opens spawned for this bundle (they would `open -g` during this restart). */
    cancelWaiters?(realPath: string): void;
  },
): Promise<Record<string, unknown>> {
  const begun = deps.registry.begin(key);
  if (!begun.ok) return { error: begun.error };
  const ticket = begun.ticket;
  try {
    const valid = await deps.validate(requested);
    if (!valid.ok) return { error: valid.error };
    if (ticket.cancelled) return { error: ERR_APP_RELEASED };
    // Another key holds the user's profile of this bundle (restarting it, or running it): that instance is
    // Sideform's, not the user's, so this open takes the temp-profile path.
    let found = ticket.userProfileHeldElsewhere(valid.realPath) ? [] : await deps.findRunning(valid.realPath).catch(() => [] as number[]);
    if (ticket.cancelled) return { error: ERR_APP_RELEASED };
    // Take the lock in the same synchronous step that decides the restart path, BEFORE the confirm.
    // Held until this open ends without a live user-profile app, or until that app's close has finished.
    if (found.length > 0 && !ticket.lockUserProfile(valid.realPath)) found = [];
    const restart = found.length > 0;
    const allowed = restart ? await deps.confirmRestart(valid) : await deps.confirm(valid);
    // A release point may have run while the dialog was open.
    if (ticket.cancelled) return { error: ERR_APP_RELEASED };
    if (!allowed) return { error: ERR_APP_DENIED };
    const reopen = () => deps.reopen(valid.realPath).catch(() => {});
    if (restart) {
      // The dialog can stay open for a long time: quit what runs now, not what ran before it.
      const pids = await deps.findRunning(valid.realPath).catch(() => found);
      if (ticket.cancelled) return { error: ERR_APP_RELEASED };
      try {
        deps.cancelWaiters?.(valid.realPath);
      } catch (err) {
        console.error("desktop app: cancel waiters failed", err);
      }
      let quitAny = false;
      for (const pid of pids) {
        // Mark BEFORE the quit: the terminate may already be in flight when Sideform quits.
        ticket.markUserAppQuit(valid.realPath, pid);
        const gone = await deps.quit(pid).catch(() => false);
        if (!gone) {
          // The terminate was sent; the user may still answer the dialog. A detached waiter reopens the app then.
          try {
            deps.reopenWhenGone?.(valid.realPath, pid);
          } catch (err) {
            console.error("desktop app: reopen waiter failed", err);
          }
          // The waiter owns the reopen now: a Sideform quit must not send another terminate or spawn a second helper.
          ticket.unmarkUserAppQuit(valid.realPath, pid);
          if (quitAny) await reopen();
          return { error: ticket.cancelled ? ERR_APP_RELEASED : errAppDidNotQuit(valid.name) };
        }
        quitAny = true;
        if (ticket.cancelled) {
          await reopen();
          return { error: ERR_APP_RELEASED };
        }
      }
    }
    const launchOpts: LaunchOptions | undefined = restart ? { userProfile: true } : undefined;
    const launched = await ticket.launch(valid.realPath, launchOpts);
    if (!launched.ok) {
      // We quit the user's app: put it back as it was (a no-op if it runs already).
      if (restart) await reopen();
      return { error: launched.error };
    }
    const listed = await launched.handle.controller.tabs({ action: "list" }).catch(() => ({}));
    // Success only if the key is still bound to this very app.
    if (deps.registry.get(key) !== launched.handle) return { error: ticket.cancelled ? ERR_APP_RELEASED : ERR_APP_GONE };
    return shapeLaunchResult(listed, valid.name, launchOpts);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not open the app." };
  } finally {
    ticket.abort();
  }
}
