import type { CredentialStore, CredentialSummary } from "./credentialStore";

/**
 * Request handlers behind the Passwords window's IPC channels
 * (`passwords:list|add|update|remove|never-remove`). Pure: the window manager only
 * checks the sender and forwards the payload here.
 *
 * Nothing this module returns holds a password: `list` gives host, username
 * and label, and `add`/`update` take the password in but only send back the entry id.
 */

/** A list row: the summary plus an optional cached site icon (a data: URL of an allowed image type). */
export type PasswordsListEntry = CredentialSummary & { icon?: string };

/** The icon cache as the API sees it (browser/faviconCache.ts). */
export interface PasswordsIcons {
  get(origin: string): string | undefined;
  flushPending(): Promise<void>;
  /** Drops the icon of an origin whose last login was removed. */
  forget(origin: string): void;
}

export interface PasswordsListResult {
  entries: PasswordsListEntry[];
  never: string[];
  encryptionAvailable: boolean;
}

export type PasswordsActionResult = { ok: true } | { ok: false; error: string };
/** add/update answer with the id of the saved entry (an add can land on an existing one). */
export type PasswordsSaveResult =
  | { ok: true; id: string }
  | { ok: false; error: string; /** add only: a login for this site + username exists; send `replace: true` to overwrite it. */ exists?: true; id?: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createPasswordsApi(store: CredentialStore, icons?: PasswordsIcons) {
  return {
    list(): PasswordsListResult {
      // Icons seen earlier for a login saved since: fetched in the background, shown on the next list.
      void icons?.flushPending().catch(() => undefined);
      const entries = store.list().map((e) => {
        const icon = icons?.get(e.origin);
        return icon ? { ...e, icon } : e;
      });
      return { entries, never: store.listNever(), encryptionAvailable: store.isAvailable() };
    },

    add(payload: unknown): PasswordsSaveResult {
      if (!isRecord(payload)) return { ok: false, error: "Malformed request." };
      const { site, username, password, label, replace } = payload;
      if (typeof site !== "string" || typeof username !== "string" || typeof password !== "string") {
        return { ok: false, error: "Malformed request." };
      }
      if (label !== undefined && typeof label !== "string") return { ok: false, error: "Malformed request." };
      if (replace !== undefined && typeof replace !== "boolean") return { ok: false, error: "Malformed request." };
      if (replace !== true) {
        // Same normalization as the store's add(): main decides what "the same login" is.
        const existing = store.findExisting(site, username);
        if (existing !== null) {
          return { ok: false, error: "A login for that username already exists on this site.", exists: true, id: existing };
        }
      }
      try {
        const saved = store.add({ site, username, password, label });
        return { ok: true, id: saved.id };
      } catch (err) {
        // The store's messages are fixed strings that never echo the input.
        return { ok: false, error: err instanceof Error ? err.message : "Could not save the login." };
      }
    },

    update(payload: unknown): PasswordsSaveResult {
      if (!isRecord(payload)) return { ok: false, error: "Malformed request." };
      const { id, username, password, label } = payload;
      if (typeof id !== "string" || typeof username !== "string") return { ok: false, error: "Malformed request." };
      if (password !== undefined && typeof password !== "string") return { ok: false, error: "Malformed request." };
      if (label !== undefined && typeof label !== "string") return { ok: false, error: "Malformed request." };
      try {
        store.update(id, { username, password, label });
        return { ok: true, id };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Could not save the login." };
      }
    },

    remove(id: unknown): PasswordsActionResult {
      if (typeof id !== "string") return { ok: false, error: "Malformed request." };
      const origin = store.list().find((e) => e.id === id)?.origin;
      if (!store.remove(id)) return { ok: false, error: "That login no longer exists." };
      if (origin !== undefined && !store.list().some((e) => e.origin === origin)) icons?.forget(origin);
      return { ok: true };
    },

    removeNever(host: unknown): PasswordsActionResult {
      if (typeof host !== "string") return { ok: false, error: "Malformed request." };
      return store.removeNever(host) ? { ok: true } : { ok: false, error: "That site is not on the list." };
    },
  };
}

export type PasswordsApi = ReturnType<typeof createPasswordsApi>;
