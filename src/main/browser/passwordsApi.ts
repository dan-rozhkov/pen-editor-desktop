import type { CredentialStore, CredentialSummary } from "./credentialStore";

/**
 * Request handlers behind the Passwords window's IPC channels
 * (`passwords:list|add|remove|never-remove`). Pure: the window manager only
 * checks the sender and forwards the payload here.
 *
 * Nothing this module returns holds a password: `list` gives host, username
 * and label, and `add` takes the password in but never sends it back.
 */

export interface PasswordsListResult {
  entries: CredentialSummary[];
  never: string[];
  encryptionAvailable: boolean;
}

export type PasswordsActionResult = { ok: true } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createPasswordsApi(store: CredentialStore) {
  return {
    list(): PasswordsListResult {
      return { entries: store.list(), never: store.listNever(), encryptionAvailable: store.isAvailable() };
    },

    add(payload: unknown): PasswordsActionResult {
      if (!isRecord(payload)) return { ok: false, error: "Malformed request." };
      const { site, username, password, label } = payload;
      if (typeof site !== "string" || typeof username !== "string" || typeof password !== "string") {
        return { ok: false, error: "Malformed request." };
      }
      if (label !== undefined && typeof label !== "string") return { ok: false, error: "Malformed request." };
      try {
        store.add({ site, username, password, label });
        return { ok: true };
      } catch (err) {
        // The store's messages are fixed strings that never echo the input.
        return { ok: false, error: err instanceof Error ? err.message : "Could not save the login." };
      }
    },

    remove(id: unknown): PasswordsActionResult {
      if (typeof id !== "string") return { ok: false, error: "Malformed request." };
      return store.remove(id) ? { ok: true } : { ok: false, error: "That login no longer exists." };
    },

    removeNever(host: unknown): PasswordsActionResult {
      if (typeof host !== "string") return { ok: false, error: "Malformed request." };
      return store.removeNever(host) ? { ok: true } : { ok: false, error: "That site is not on the list." };
    },
  };
}

export type PasswordsApi = ReturnType<typeof createPasswordsApi>;
