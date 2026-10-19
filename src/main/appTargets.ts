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
export const ERR_APP_DENIED = "The user did not allow launching this app.";
export const ERR_APP_BUSY = "An app launch is already in progress for this chat.";
export const ERR_APP_CAP = `At most ${MAX_RUNNING_APPS} desktop apps can run at once. Release one first.`;
export const ERR_APP_RELEASED = "The app was released before it finished launching.";
export const ERR_APP_QUIT_ON_LAUNCH = "The app quit right after it launched.";

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
}

export type AppPathResult = { ok: true; realPath: string; name: string } | { ok: false; error: string };

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
  return { ok: true, realPath: real, name: path.basename(real, ".app") };
}

// ------------------------------------------------------------------ confirm

export const APP_CONFIRM_BUTTONS = ["Allow once", "Allow until Sideform quits", "Don't allow"] as const;

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
    async confirm(win: W, app: { name: string; realPath: string }, owner: number): Promise<boolean> {
      if (remembered.has(memo(owner, app.realPath))) return true;
      const { response } = await deps.showMessageBox(win, {
        type: "question",
        message: `Let the AI agent launch and control "${app.name}"?`,
        detail:
          `${app.realPath}\n\n` +
          "The app runs with your user rights, not in a sandbox: it can reach your files, run commands, and may use saved credentials such as keychain items. " +
          "It starts with a fresh profile, but that does not limit what it can do. The agent will see and click inside its windows. Allow it only if you trust this app.",
        buttons: [...APP_CONFIRM_BUTTONS],
        defaultId: 2,
        cancelId: 2,
        noLink: true,
      });
      if (response === 0) return true;
      if (response === 1) {
        remembered.add(memo(owner, app.realPath));
        return true;
      }
      return false;
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
  onDisconnected(cb: () => void): void;
  close(): Promise<void>;
}

export const appKey = (senderId: number, sessionId: string | undefined): string => `${senderId}:${sessionId ?? ""}`;

export type LaunchOutcome<H> = { ok: true; handle: H } | { ok: false; error: string };
/** none: no binding; pending: an open is validating/confirming/launching; running; gone: it quit (sticky until released). */
export type AppState = "none" | "pending" | "running" | "gone";

export interface LaunchTicket<H> {
  /** True once a release point cancelled this open. */
  readonly cancelled: boolean;
  /** Launch under the still-live key; closes the previous app of the key only after the new one is up. */
  launch(appPath: string): Promise<LaunchOutcome<H>>;
  /** Drop the reservation (idempotent; a no-op after launch). */
  abort(): void;
}

export function createAppRegistry<H extends AppHandle>(deps: {
  launch(appPath: string): Promise<H>;
  maxApps?: number;
  /** Synchronous SIGKILL + profile removal, for quit (`killAllSync`). */
  killSync?(handle: H): void;
  /** Whether the app process still runs (checked right after launch). */
  isAlive?(handle: H): boolean;
}) {
  const max = deps.maxApps ?? MAX_RUNNING_APPS;
  type Binding = { handle: H } | { gone: true };
  type Flight = { cancelled: boolean; spawned: boolean };
  const bindings = new Map<string, Binding>();
  // A flight stays here until its validate/confirm/launch/close fully finished, cancelled or not.
  const pending = new Map<string, Flight>();
  // Every handle that is spawned and not yet fully closed (running, replaced, or cancelled).
  const live = new Set<H>();
  const closing = new Map<H, Promise<void>>();

  const closeQuietly = (h: H): Promise<void> => {
    let p = closing.get(h);
    if (!p) {
      p = h.close().catch((err) => console.error("desktop app: close failed", err)).finally(() => live.delete(h));
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
      const finish = () => {
        if (pending.get(key) === flight) pending.delete(key);
      };
      const ticket: LaunchTicket<H> = {
        get cancelled() {
          return flight.cancelled;
        },
        abort: finish,
        async launch(appPath) {
          if (flight.cancelled) return { ok: false, error: ERR_APP_RELEASED };
          try {
            let handle: H;
            try {
              handle = await deps.launch(appPath);
            } catch (err) {
              return { ok: false, error: err instanceof Error ? err.message : "Could not launch the app." };
            }
            flight.spawned = true;
            live.add(handle);
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
            return { ok: true, handle };
          } finally {
            finish();
          }
        },
      };
      return { ok: true, ticket };
    },
    release,
    releaseWhere,
    releaseAll: (): Promise<void> => releaseWhere(() => true),
    /**
     * Quit path, synchronous: SIGKILL every spawned app and remove its profile before
     * the process exits (an async close would be cut off, and close() unhooks the
     * launcher's own exit handler first). Not a graceful shutdown.
     */
    killAllSync(): void {
      for (const flight of pending.values()) flight.cancelled = true;
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
export function shapeLaunchResult(listed: unknown, name: string): Record<string, unknown> {
  const l = typeof listed === "object" && listed !== null ? (listed as { tabs?: { url?: string; title?: string; current?: boolean }[] }) : {};
  const current = l.tabs?.find((t) => t.current) ?? l.tabs?.[0];
  return { ...l, url: current?.url ?? "", title: current?.title ?? "", app: name };
}

/** The whole app open: reserve, validate, confirm, launch. Never throws. */
export async function openApp<H extends AppHandle & { controller: Pick<AppController, "tabs"> }>(
  key: string,
  requested: unknown,
  deps: {
    registry: Pick<AppRegistry<H>, "begin" | "get">;
    validate(input: unknown): Promise<AppPathResult>;
    confirm(app: { name: string; realPath: string }): Promise<boolean>;
  },
): Promise<Record<string, unknown>> {
  const begun = deps.registry.begin(key);
  if (!begun.ok) return { error: begun.error };
  const ticket = begun.ticket;
  try {
    const valid = await deps.validate(requested);
    if (!valid.ok) return { error: valid.error };
    if (ticket.cancelled) return { error: ERR_APP_RELEASED };
    const allowed = await deps.confirm(valid);
    // A release point may have run while the dialog was open.
    if (ticket.cancelled) return { error: ERR_APP_RELEASED };
    if (!allowed) return { error: ERR_APP_DENIED };
    const launched = await ticket.launch(valid.realPath);
    if (!launched.ok) return { error: launched.error };
    const listed = await launched.handle.controller.tabs({ action: "list" }).catch(() => ({}));
    // Success only if the key is still bound to this very app.
    if (deps.registry.get(key) !== launched.handle) return { error: ticket.cancelled ? ERR_APP_RELEASED : ERR_APP_GONE };
    return shapeLaunchResult(listed, valid.name);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not open the app." };
  } finally {
    ticket.abort();
  }
}
