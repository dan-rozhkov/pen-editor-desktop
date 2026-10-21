import { isRecord, type LoginSummary, type PasswordsApi } from "./browser/passwordsApi";

/**
 * Sender rules and payload handling of `logins:list` / `logins:add`: the saved-logins bridge of the
 * Markdown (doc) tabs, for their `@` mention picker. Kept out of window.ts and passwordsService.ts so it is unit-tested.
 * Separate from the `passwords:*` channels, which stay Passwords-tab only.
 *
 * Only the top frame of a doc tab that still shows the doc page (on the editor origin) may call. No result holds a
 * password. A doc tab can add a login but never overwrite one (`replace` is dropped), and only after the user
 * confirmed in a native dialog (one at a time per window).
 */

/** One main window's doc tabs, as `logins:*` sees them. */
export interface LoginsPort {
  /** True for a doc tab of this window that shows the doc page now: the view AND the sender frame's own URL. */
  isDocViewer(webContentsId: number, frameUrl: string | undefined): boolean;
  /** Native "Save this login?" dialog on this window; true = Save. Never throws. */
  confirmAdd(info: { host: string; username: string }): Promise<boolean>;
}

/** Who is calling: the sender and its frame, read from the IPC event. */
export interface LoginsCaller {
  senderId: number;
  /** `senderFrame` is the sender's main frame. */
  topFrame: boolean;
  /** `senderFrame.url`. */
  frameUrl: string | undefined;
}

export interface LoginsIpcDeps {
  api: Pick<PasswordsApi, "listSummaries" | "precheckAdd" | "add">;
  /** The window whose doc viewer the sender is (resolved once per call), else null. */
  resolvePort(webContentsId: number, frameUrl: string | undefined): LoginsPort | null;
  /** Tells the open Passwords tabs that the stored data changed. */
  notifyChanged(): void;
}

/** Answer for a sender that may not use a channel (shared with the Passwords service). */
export const DENIED = { ok: false, error: "Not allowed." } as const;

/** Windows with a confirmation dialog open: a second add on the same window is refused. */
const pending = new WeakSet<LoginsPort>();

const portOf = (deps: LoginsIpcDeps, caller: LoginsCaller): LoginsPort | null =>
  caller.topFrame ? deps.resolvePort(caller.senderId, caller.frameUrl) : null;

/** Native dialog copy. The page-controlled username goes in `detail`, never next to (or before) the host. */
export function addLoginCopy(info: { host: string; username: string }) {
  return {
    message: `Save a login for ${info.host}?`,
    detail: `Username: ${info.username}\n\nA document asked to save this login in the built-in browser.`,
    buttons: ["Save", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  };
}

/** `logins:list` (invoke): `{entries, encryptionAvailable}`. */
export function handleLoginsList(
  deps: LoginsIpcDeps,
  caller: LoginsCaller,
): { entries: LoginSummary[]; encryptionAvailable: boolean } | typeof DENIED {
  if (portOf(deps, caller) === null) return DENIED;
  return deps.api.listSummaries();
}

/** `logins:add` (invoke). Forwards only `site`, `username`, `password` and `label`. Asks the user before storing. */
export async function handleLoginsAdd(deps: LoginsIpcDeps, caller: LoginsCaller, payload: unknown) {
  const port = portOf(deps, caller);
  if (port === null) return DENIED;
  if (!isRecord(payload)) return { ok: false, error: "Malformed request." } as const;
  const { site, username, password, label } = payload;
  const clean = { site, username, password, label };
  const pre = deps.api.precheckAdd(clean);
  if (!pre.ok) return pre;
  if (pending.has(port)) return { ok: false, error: "Another save is waiting for confirmation." } as const;
  pending.add(port);
  let confirmed: boolean;
  try {
    confirmed = await port.confirmAdd({ host: pre.host, username: pre.username });
  } finally {
    pending.delete(port);
  }
  // The tab may have left the doc page, closed, or its window gone while the dialog was open.
  if (portOf(deps, caller) !== port) return DENIED;
  if (!confirmed) return { ok: false, error: "Cancelled." } as const;
  // Re-checked inside add(): a login may have appeared while the dialog was open.
  const result = deps.api.add(clean);
  if (result.ok) deps.notifyChanged();
  return result;
}
