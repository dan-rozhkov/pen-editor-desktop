import type { ChatListResult, ChatReadResult, ChatRemoveResult, ChatSaveResult, ChatStore } from "./chatStore";
import { isPanelDocument } from "./windowTheme";

/** Sender rules of `chats:list|read|save|delete`, kept out of window.ts so they are unit-tested. */
export interface ChatIpcDeps {
  store: Pick<ChatStore, "list" | "read" | "save" | "remove">;
  /**
   * The panel page URL of an agent panel webContents of this process, or undefined for any other sender.
   * An id stays known for a grace period after the panel is destroyed (canvasWriters.ts), so a last save lands.
   */
  panelUrlOf(webContentsId: number): string | undefined;
}

/** The sender's identity: its webContents id and the URL of the frame that sent the message (null if gone). */
export interface ChatSender {
  id: number;
  frameUrl: string | null;
}

/**
 * Only an agent panel's own page may use chat storage (not its offline fallback, not any other view).
 * A frame that is already gone (null URL: the panel was destroyed while it flushed) is accepted for a known panel id.
 */
export function isChatSender(deps: Pick<ChatIpcDeps, "panelUrlOf">, sender: ChatSender): boolean {
  const panelUrl = deps.panelUrlOf(sender.id);
  if (panelUrl === undefined) return false;
  return sender.frameUrl === null || isPanelDocument(sender.frameUrl, panelUrl);
}

const errorOf = (err: unknown): { error: string } => ({ error: err instanceof Error ? err.message : String(err) });

/** `chats:list` (invoke). Never throws. */
export async function handleChatList(deps: ChatIpcDeps, sender: ChatSender): Promise<ChatListResult> {
  if (!isChatSender(deps, sender)) return { error: "chats:list is not allowed from this sender" };
  try {
    return await deps.store.list();
  } catch (err) {
    return errorOf(err);
  }
}

/** `chats:read` (invoke). Never throws. */
export async function handleChatRead(deps: ChatIpcDeps, sender: ChatSender, id: unknown): Promise<ChatReadResult> {
  if (!isChatSender(deps, sender)) return { error: "chats:read is not allowed from this sender" };
  try {
    return await deps.store.read(id);
  } catch (err) {
    return errorOf(err);
  }
}

/** `chats:save` (invoke). Never throws. */
export async function handleChatSave(deps: ChatIpcDeps, sender: ChatSender, chat: unknown): Promise<ChatSaveResult> {
  if (!isChatSender(deps, sender)) return { error: "chats:save is not allowed from this sender" };
  try {
    return await deps.store.save(chat);
  } catch (err) {
    return errorOf(err);
  }
}

/** `chats:delete` (invoke). Never throws. */
export async function handleChatDelete(deps: ChatIpcDeps, sender: ChatSender, id: unknown): Promise<ChatRemoveResult> {
  if (!isChatSender(deps, sender)) return { error: "chats:delete is not allowed from this sender" };
  try {
    return await deps.store.remove(id);
  } catch (err) {
    return errorOf(err);
  }
}
