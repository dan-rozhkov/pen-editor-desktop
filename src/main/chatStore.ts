import * as path from "node:path";
import { nodeDocFs, type DocFs } from "./docStore";
import { createKeyedChain, isObject, message, sweepStaleTmp } from "./storeUtils";

/**
 * Local storage of the agent panel's chats, on the same principle as canvasStore.ts. Two files per chat in `<root>/`:
 *   `<id>.meta.json` = `{id, title, titleIsAuto, model, updatedAt, rev, messageCount}`   (small; `list` reads only these)
 *   `<id>.chat.json` = `{id, rev, messages}`                                              (`messages` = the AI SDK `UIMessage[]`)
 * Write order: body first, then meta. A meta without a matching body (or a body whose rev is below the
 * meta rev) reads as null. Newer-rev-wins, per-id promise chain, in-memory rev cache and the temp-file
 * sweep behave as in canvasStore. Chats are user data and are never pruned. Pure and Electron-free (fs is a port).
 */

export const CHAT_DIR = "chats";
/** Directory used while `PEN_DESKTOP_URL` overrides the editor: a dev frontend must never touch production chats. */
export const DEV_CHAT_DIR = "chats-dev";

/** The chats directory name: `chats-dev` when the editor URL is overridden, else `chats`. */
export function chatDirFor(overrideActive: boolean): string {
  return overrideActive ? DEV_CHAT_DIR : CHAT_DIR;
}

export const MAX_CHAT_TITLE_CHARS = 10_000;
export const MAX_CHAT_MODEL_CHARS = 200;
export const MAX_CHAT_BODY_BYTES = 64 * 1024 * 1024;

const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isValidChatId = (id: unknown): id is string => typeof id === "string" && CHAT_ID.test(id);

export interface ChatMeta {
  id: string;
  title: string;
  titleIsAuto: boolean;
  model: string;
  updatedAt: number;
  rev: number;
  messageCount: number;
}

export interface StoredChat {
  id: string;
  title: string;
  titleIsAuto: boolean;
  model: string;
  updatedAt: number;
  rev: number;
  messages: unknown[];
}

export type ChatListResult = { chats: ChatMeta[] } | { error: string };
export type ChatReadResult = { chat: (ChatMeta & { messages: unknown[] }) | null } | { error: string };
export type ChatSaveResult = { ok: true; rev: number } | { ok: true; stale: true; rev: number } | { error: string };
export type ChatRemoveResult = { ok: true } | { error: string };

export interface ChatStore {
  /** Metadata of every valid stored chat (meta files only). Never throws. */
  list(): Promise<ChatListResult>;
  /** One chat with its messages, or `{chat:null}` when absent, incomplete or stale. Never throws. */
  read(id: unknown): Promise<ChatReadResult>;
  /** Validates and stores a chat (newer rev wins). Never throws. */
  save(chat: unknown): Promise<ChatSaveResult>;
  /** Deletes a chat; a missing one is fine. Never throws. */
  remove(id: unknown): Promise<ChatRemoveResult>;
}

export interface ChatStoreOptions {
  /** Absolute path of the chats directory (`<userData>/chats`). */
  rootDir: string;
  fs?: DocFs;
  /** Clock for sweeping stale temp files. Default Date.now. */
  now?: () => number;
}

/** Meta files read at once by `list`. */
const LIST_CONCURRENCY = 16;
const META_NAME = /^([A-Za-z0-9_-]{1,128})\.meta\.json$/;
const isRev = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/** The meta fields of a stored meta file, or an error. */
export function parseChatMeta(raw: unknown): { meta: ChatMeta } | { error: string } {
  if (!isObject(raw)) return { error: "invalid chat" };
  const { id, title, titleIsAuto, model, updatedAt, rev, messageCount } = raw;
  if (!isValidChatId(id)) return { error: "invalid chat id" };
  if (typeof title !== "string" || title.length > MAX_CHAT_TITLE_CHARS) return { error: "invalid title" };
  if (typeof titleIsAuto !== "boolean") return { error: "invalid titleIsAuto" };
  if (typeof model !== "string" || model.length > MAX_CHAT_MODEL_CHARS) return { error: "invalid model" };
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return { error: "invalid updatedAt" };
  if (!isRev(rev)) return { error: "invalid rev" };
  if (typeof messageCount !== "number" || !Number.isSafeInteger(messageCount) || messageCount < 0) return { error: "invalid messageCount" };
  return { meta: { id, title, titleIsAuto, model, updatedAt, rev, messageCount } };
}

/** A chat to store (payload of `chats:save`), or an error. Anything else on the input is dropped. */
export function parseStoredChat(raw: unknown): { chat: StoredChat } | { error: string } {
  if (!isObject(raw)) return { error: "invalid chat" };
  const { messages } = raw;
  if (!Array.isArray(messages)) return { error: "invalid messages" };
  const parsed = parseChatMeta({ ...raw, messageCount: messages.length });
  if ("error" in parsed) return parsed;
  const { messageCount: _count, ...fields } = parsed.meta;
  return { chat: { ...fields, messages } };
}

export function createChatStore(opts: ChatStoreOptions): ChatStore {
  const { rootDir } = opts;
  const io = opts.fs ?? nodeDocFs;
  const now = opts.now ?? Date.now;
  // Last known stored (meta) rev per id. This process is the only writer, so it stays true.
  const revs = new Map<string, number>();
  const metaFile = (id: string) => path.join(rootDir, `${id}.meta.json`);
  const bodyFile = (id: string) => path.join(rootDir, `${id}.chat.json`);
  const serialized = createKeyedChain();

  /** The stored meta at `id`, or null when absent or unusable (a corrupt file is overwritten by the next save). */
  async function readMeta(id: string): Promise<ChatMeta | null> {
    const bytes = await io.read(metaFile(id));
    if (bytes === null) return null;
    try {
      const parsed = parseChatMeta(JSON.parse(bytes.toString("utf8")));
      return "meta" in parsed && parsed.meta.id === id ? parsed.meta : null;
    } catch {
      return null;
    }
  }

  async function list(): Promise<ChatListResult> {
    try {
      const files = await io.listFiles(rootDir);
      await sweepStaleTmp(io, rootDir, files, now, "chatStore");
      const names = files.map((f) => f.name).filter((name) => META_NAME.test(name)); // bodies, temp files and strangers are skipped
      const found: (ChatMeta | null)[] = new Array(names.length).fill(null);
      let next = 0;
      const worker = async () => {
        while (next < names.length) {
          const i = next++;
          const name = names[i];
          const id = META_NAME.exec(name)![1];
          try {
            found[i] = await serialized(id, async (): Promise<ChatMeta | null> => {
              const bytes = await io.read(path.join(rootDir, name));
              if (bytes === null) return null; // removed meanwhile
              const parsed = parseChatMeta(JSON.parse(bytes.toString("utf8")));
              if ("error" in parsed) {
                console.error(`chatStore: skipping ${name}: ${parsed.error}`);
                return null;
              }
              if (parsed.meta.id !== id) {
                console.error(`chatStore: skipping ${name}: id mismatch`);
                return null;
              }
              revs.set(id, parsed.meta.rev);
              return parsed.meta;
            });
          } catch (err) {
            console.error(`chatStore: skipping ${name}: ${message(err)}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, names.length) }, worker));
      const chats = found.filter((m): m is ChatMeta => m !== null);
      chats.sort((a, b) => b.updatedAt - a.updatedAt);
      return { chats };
    } catch (err) {
      return { error: `could not list chats: ${message(err)}` };
    }
  }

  async function read(id: unknown): Promise<ChatReadResult> {
    if (!isValidChatId(id)) return { error: "invalid chat id" };
    try {
      return await serialized(id, async (): Promise<ChatReadResult> => {
        const meta = await readMeta(id);
        if (meta === null) return { chat: null };
        const bytes = await io.read(bodyFile(id));
        if (bytes === null) return { chat: null };
        let body: unknown;
        try {
          body = JSON.parse(bytes.toString("utf8"));
        } catch {
          return { chat: null };
        }
        if (!isObject(body) || body.id !== id || !isRev(body.rev) || body.rev < meta.rev || !Array.isArray(body.messages)) {
          return { chat: null };
        }
        return { chat: { ...meta, messages: body.messages } };
      });
    } catch (err) {
      return { error: `could not read chat: ${message(err)}` };
    }
  }

  async function save(raw: unknown): Promise<ChatSaveResult> {
    const parsed = parseStoredChat(raw);
    if ("error" in parsed) return { error: parsed.error };
    const chat = parsed.chat;
    let bodyBytes: Buffer;
    try {
      bodyBytes = Buffer.from(JSON.stringify({ id: chat.id, rev: chat.rev, messages: chat.messages }), "utf8");
    } catch {
      return { error: "messages are not serializable" };
    }
    if (bodyBytes.length > MAX_CHAT_BODY_BYTES) return { error: "chat too large" };
    try {
      return await serialized(chat.id, async (): Promise<ChatSaveResult> => {
        let storedRev = revs.get(chat.id);
        if (storedRev === undefined) {
          storedRev = (await readMeta(chat.id))?.rev;
          if (storedRev !== undefined) revs.set(chat.id, storedRev);
        }
        if (storedRev !== undefined && storedRev >= chat.rev) return { ok: true, stale: true, rev: storedRev };
        // Body first: a crash between the two writes leaves the old meta, whose rev the body still satisfies.
        await io.write(bodyFile(chat.id), bodyBytes);
        const meta: ChatMeta = {
          id: chat.id,
          title: chat.title,
          titleIsAuto: chat.titleIsAuto,
          model: chat.model,
          updatedAt: chat.updatedAt,
          rev: chat.rev,
          messageCount: chat.messages.length,
        };
        await io.write(metaFile(chat.id), Buffer.from(JSON.stringify(meta), "utf8"));
        revs.set(chat.id, chat.rev);
        return { ok: true, rev: chat.rev };
      });
    } catch (err) {
      return { error: `could not write chat: ${message(err)}` };
    }
  }

  async function remove(id: unknown): Promise<ChatRemoveResult> {
    if (!isValidChatId(id)) return { error: "invalid chat id" };
    try {
      await serialized(id, async () => {
        await io.remove(metaFile(id)); // meta first: a half-deleted chat disappears from the list
        await io.remove(bodyFile(id));
        revs.delete(id); // only once BOTH files are really gone; a failed unlink keeps the cache
      });
      return { ok: true };
    } catch (err) {
      return { error: `could not delete chat: ${message(err)}` };
    }
  }

  return { list, read, save, remove };
}
