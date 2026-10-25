import { describe, expect, it, vi } from "vitest";
import { handleChatDelete, handleChatList, handleChatRead, handleChatSave, isChatSender, type ChatIpcDeps } from "../src/main/chatIpc";

const PANEL_URL = "https://app.example.com/agent";
const PANEL_ID = 7;

function deps() {
  return {
    store: {
      list: vi.fn(async () => ({ chats: [] })),
      read: vi.fn(async () => ({ chat: null })),
      save: vi.fn(async () => ({ ok: true as const, rev: 1 })),
      remove: vi.fn(async () => ({ ok: true as const })),
    },
    panelUrlOf: (id: number) => (id === PANEL_ID ? PANEL_URL : undefined),
  } satisfies ChatIpcDeps;
}
const panel = { id: PANEL_ID, frameUrl: PANEL_URL };

describe("chats:* sender rules", () => {
  it("allows the agent panel's own page everything", async () => {
    const d = deps();
    expect(await handleChatList(d, panel)).toEqual({ chats: [] });
    expect(await handleChatRead(d, panel, "a")).toEqual({ chat: null });
    expect(await handleChatSave(d, panel, { id: "a" })).toEqual({ ok: true, rev: 1 });
    expect(await handleChatDelete(d, panel, "a")).toEqual({ ok: true });
    expect(d.store.read).toHaveBeenCalledWith("a");
    expect(d.store.save).toHaveBeenCalledWith({ id: "a" });
    expect(d.store.remove).toHaveBeenCalledWith("a");
  });

  it("accepts a subpath of the panel page and a gone frame of a known panel", () => {
    const d = deps();
    expect(isChatSender(d, { id: PANEL_ID, frameUrl: `${PANEL_URL}/x` })).toBe(true);
    expect(isChatSender(d, { id: PANEL_ID, frameUrl: null })).toBe(true);
  });

  it("refuses every other webContents, and the panel's offline fallback or a foreign page", async () => {
    const d = deps();
    const others = [
      { id: 99, frameUrl: PANEL_URL },
      { id: 99, frameUrl: null },
      { id: PANEL_ID, frameUrl: "file:///app/offline.html" },
      { id: PANEL_ID, frameUrl: "https://evil.example.com/agent" },
      { id: PANEL_ID, frameUrl: "https://app.example.com/app" },
    ];
    for (const sender of others) {
      expect(await handleChatList(d, sender)).toEqual({ error: "chats:list is not allowed from this sender" });
      expect(await handleChatRead(d, sender, "a")).toEqual({ error: "chats:read is not allowed from this sender" });
      expect(await handleChatSave(d, sender, { id: "a" })).toEqual({ error: "chats:save is not allowed from this sender" });
      expect(await handleChatDelete(d, sender, "a")).toEqual({ error: "chats:delete is not allowed from this sender" });
    }
    expect(d.store.list).not.toHaveBeenCalled();
    expect(d.store.save).not.toHaveBeenCalled();
    expect(d.store.remove).not.toHaveBeenCalled();
  });

  it("passes unvalidated payloads to the store, which validates", async () => {
    const d = deps();
    d.store.save.mockResolvedValueOnce({ error: "invalid rev" } as never);
    expect(await handleChatSave(d, panel, { id: "a", rev: 0 })).toEqual({ error: "invalid rev" });
  });

  it("turns a throwing store into an error value", async () => {
    const d = deps();
    d.store.list.mockRejectedValueOnce(new Error("boom"));
    d.store.save.mockRejectedValueOnce("bad");
    expect(await handleChatList(d, panel)).toEqual({ error: "boom" });
    expect(await handleChatSave(d, panel, {})).toEqual({ error: "bad" });
  });
});
