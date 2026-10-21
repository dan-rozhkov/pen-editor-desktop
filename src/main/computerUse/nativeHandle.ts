// The registry handle of a natively controlled app (spec section 3). Electron-free: the helper,
// the overlay and the image encoder are injected. Safety: close() and destroyOverlay() never quit,
// kill or restart the user's app; the handle has no pid so nothing can.
import { createNativeAppController, type CursorSink, type NativeAppController, type NativeControllerDeps } from "./nativeController";
import { ERR_APP_QUIT_ON_LAUNCH } from "../appTargets";
import { ERR_HELPER_MISSING } from "./errors";
import { HelperError, type ComputerUseHelper } from "./helperClient";

export interface NativeHandleDeps {
  helper: Pick<ComputerUseHelper, "call" | "onEvent" | "onExit">;
  pid: number;
  appPath: string;
  /** Looks up name and bundle id of the pid (helper listApps). */
  describe(pid: number): Promise<{ name: string; bundleId?: string } | undefined>;
  overlay: CursorSink & { destroy(): void };
  encodeImage?: NativeControllerDeps["encodeImage"];
}

export interface NativeHandle {
  controller: NativeAppController;
  pid: undefined;
  native: true;
  appPath: string;
  userProfile: false;
  profileDir: null;
  readonly disconnected: boolean;
  name: string;
  onDisconnected(cb: () => void): void;
  /** Quit path: only the overlay goes. */
  destroyOverlay(): void;
  close(): Promise<void>;
}

export async function createNativeHandle(deps: NativeHandleDeps): Promise<NativeHandle> {
  const { helper, pid, overlay } = deps;
  const info = await deps.describe(pid).catch(() => undefined);
  const name = info?.name ?? deps.appPath;
  let disconnected = false;
  let closed = false;
  const listeners: Array<() => void> = [];
  const fire = () => {
    if (disconnected) return;
    disconnected = true;
    for (const cb of listeners.splice(0)) cb();
  };
  const offEvent = helper.onEvent((e) => {
    if (e.event === "appTerminated" && e.pid === pid) fire();
  });
  const offExit = helper.onExit(() => fire());
  // A failed watch means we would never learn that the app quit (or it already quit during the confirm
  // dialog, NOT_FOUND): the launch fails instead of binding a handle to a dead or unwatched app.
  try {
    await helper.call("watch", { pid });
  } catch (e) {
    offEvent();
    offExit();
    listeners.length = 0;
    overlay.destroy();
    if (e instanceof HelperError && e.code === "HELPER_SPAWN") throw new Error(ERR_HELPER_MISSING);
    if (e instanceof HelperError && e.code === "NOT_FOUND") throw new Error(ERR_APP_QUIT_ON_LAUNCH);
    throw new Error(e instanceof Error && e.message !== "" ? `Could not watch the app: ${e.message}` : ERR_APP_QUIT_ON_LAUNCH);
  }

  const controller = createNativeAppController({ helper, pid, name, bundleId: info?.bundleId, cursor: overlay, encodeImage: deps.encodeImage });

  return {
    controller,
    pid: undefined,
    native: true,
    appPath: deps.appPath,
    userProfile: false,
    profileDir: null,
    name,
    get disconnected() {
      return disconnected;
    },
    onDisconnected(cb) {
      if (disconnected) cb();
      else listeners.push(cb);
    },
    destroyOverlay: () => overlay.destroy(),
    async close() {
      if (closed) return;
      closed = true;
      offEvent();
      offExit();
      listeners.length = 0;
      overlay.destroy();
    },
  };
}
