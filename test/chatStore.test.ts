import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { chatDirFor, createChatStore, isValidChatId, MAX_CHAT_MODEL_CHARS, MAX_CHAT_TITLE_CHARS } from "../src/main/chatStore";
import type { DocFs } from "../src/main/docStore";

const ROOT = "/ud/chats";
const MSGS = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];
const chat = (over: Record<string, unknown> = {}) => ({
  id: "tab-1761400000000-3",
  title: "T",
  titleIsAuto: true,
  model: "deepseek-flash",
  updatedAt: 10,
  rev: 1,
  messages: MSGS,
  ...over,
});
const ID = "tab-1761400000000-3";

function memFs() {
  const files = new Map<string, Buffer>();
  const mtimes = new Map<string, number>();
  const order: string[] = [];
  const api: DocFs & { files: Map<string, Buffer>; mtimes: Map<string, number>; order: string[]; delay: number; fail?: RegExp; writes: number; reads: string[] } = {
    files,
    mtimes,
    order,
    delay: 0,
    writes: 0,
    reads: [],
    read: async (p) => {
      api.reads.push(path.basename(p));
      if (api.delay) await new Promise((r) => setTimeout(r, api.delay));
      return files.get(p) ?? null;
    },
    async write(p, data) {
      if (api.fail?.test(p)) throw new Error("disk full");
      api.writes++;
      order.push(path.basename(p));
      files.set(p, data);
    },
    listFiles: async (dir) =>
      [...files.keys()].filter((p) => path.dirname(p) === dir).map((p) => ({ name: path.basename(p), mtimeMs: mtimes.get(p) ?? 0 })),
    remove: async (p) => void files.delete(p),
  };
  return api;
}
const setup = () => {
  const fs = memFs();
  const clock = { t: 10 * 3_600_000 };
  return { fs, clock, store: createChatStore({ rootDir: ROOT, fs, now: () => clock.t }) };
};
const meta = (id: string) => path.join(ROOT, `${id}.meta.json`);
const body = (id: string) => path.join(ROOT, `${id}.chat.json`);
const listed = (over: Record<string, unknown> = {}) => ({
  id: ID,
  title: "T",
  titleIsAuto: true,
  model: "deepseek-flash",
  updatedAt: 10,
  rev: 1,
  messageCount: 1,
  ...over,
});

describe("chatStore", () => {
  it("names the dev dir while the editor URL is overridden", () => {
    expect(chatDirFor(false)).toBe("chats");
    expect(chatDirFor(true)).toBe("chats-dev");
  });

  it("accepts frontend chat ids and refuses unsafe ones", () => {
    expect(isValidChatId("tab-1761400000000-3")).toBe(true);
    expect(isValidChatId("a".repeat(128))).toBe(true);
    for (const bad of ["", "a".repeat(129), "a/b", "../x", "a.b", 5, null]) expect(isValidChatId(bad)).toBe(false);
  });

  it("lists nothing for a missing dir", async () => {
    expect(await setup().store.list()).toEqual({ chats: [] });
  });

  it("saves body first, then meta, and strips unknown fields", async () => {
    const { store, fs } = setup();
    expect(await store.save({ ...chat(), extra: "x" })).toEqual({ ok: true, rev: 1 });
    expect(fs.order).toEqual([`${ID}.chat.json`, `${ID}.meta.json`]);
    expect(JSON.parse(fs.files.get(meta(ID))!.toString())).toEqual(listed());
    expect(JSON.parse(fs.files.get(body(ID))!.toString())).toEqual({ id: ID, rev: 1, messages: MSGS });
  });

  it("list reads only meta files and sorts by updatedAt, newest first", async () => {
    const { store, fs } = setup();
    await store.save(chat({ id: "c1", updatedAt: 5 }));
    await store.save(chat({ id: "c2", title: "Two", updatedAt: 50 }));
    await store.save(chat({ id: "c3", updatedAt: 20 }));
    fs.reads.length = 0;
    const result = await store.list();
    expect("chats" in result && result.chats.map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
    expect(fs.reads.every((n) => n.endsWith(".meta.json"))).toBe(true);
  });

  it("read returns meta plus messages", async () => {
    const { store } = setup();
    await store.save(chat());
    expect(await store.read(ID)).toEqual({ chat: { ...listed(), messages: MSGS } });
    expect(await store.read("nope")).toEqual({ chat: null });
    expect(await store.read("../x")).toEqual({ error: "invalid chat id" });
  });

  it("read gives null for a missing body or a body below the meta rev", async () => {
    const { store, fs } = setup();
    await store.save(chat({ rev: 3 }));
    fs.files.set(body(ID), Buffer.from(JSON.stringify({ id: ID, rev: 2, messages: [] })));
    expect(await store.read(ID)).toEqual({ chat: null });
    fs.files.delete(body(ID));
    expect(await store.read(ID)).toEqual({ chat: null });
  });

  it("read gives null for a corrupt body or a body without messages", async () => {
    const { store, fs } = setup();
    await store.save(chat());
    fs.files.set(body(ID), Buffer.from("{nope"));
    expect(await store.read(ID)).toEqual({ chat: null });
    fs.files.set(body(ID), Buffer.from(JSON.stringify({ id: ID, rev: 1, messages: "x" })));
    expect(await store.read(ID)).toEqual({ chat: null });
  });

  it("newer rev wins; an equal or lower rev is stale and writes nothing", async () => {
    const { store, fs } = setup();
    await store.save(chat({ rev: 2, title: "two" }));
    const writes = fs.writes;
    expect(await store.save(chat({ rev: 2, title: "other" }))).toEqual({ ok: true, stale: true, rev: 2 });
    expect(await store.save(chat({ rev: 1 }))).toEqual({ ok: true, stale: true, rev: 2 });
    expect(fs.writes).toBe(writes);
    expect(await store.save(chat({ rev: 3, title: "three" }))).toEqual({ ok: true, rev: 3 });
    expect(await store.read(ID)).toEqual({ chat: { ...listed({ rev: 3, title: "three" }), messages: MSGS } });
  });

  it("a new store instance reads the stored rev from the meta file", async () => {
    const { store, fs } = setup();
    await store.save(chat({ rev: 4 }));
    const again = createChatStore({ rootDir: ROOT, fs });
    expect(await again.save(chat({ rev: 4 }))).toEqual({ ok: true, stale: true, rev: 4 });
  });

  it("messageCount follows messages.length", async () => {
    const { store, fs } = setup();
    await store.save(chat({ messages: [...MSGS, ...MSGS, ...MSGS] }));
    expect(JSON.parse(fs.files.get(meta(ID))!.toString()).messageCount).toBe(3);
  });

  it("rejects invalid input", async () => {
    const { store, fs } = setup();
    const bad: [unknown, string][] = [
      [null, "invalid chat"],
      [[], "invalid chat"],
      [chat({ id: "a/b" }), "invalid chat id"],
      [chat({ id: "" }), "invalid chat id"],
      [chat({ title: 5 }), "invalid title"],
      [chat({ title: "x".repeat(MAX_CHAT_TITLE_CHARS + 1) }), "invalid title"],
      [chat({ titleIsAuto: "yes" }), "invalid titleIsAuto"],
      [chat({ model: 1 }), "invalid model"],
      [chat({ model: "m".repeat(MAX_CHAT_MODEL_CHARS + 1) }), "invalid model"],
      [chat({ messages: "x" }), "invalid messages"],
      [chat({ messages: undefined }), "invalid messages"],
      [chat({ updatedAt: NaN }), "invalid updatedAt"],
      [chat({ updatedAt: "1" }), "invalid updatedAt"],
      [chat({ rev: 0 }), "invalid rev"],
      [chat({ rev: 1.5 }), "invalid rev"],
      [chat({ rev: Number.MAX_SAFE_INTEGER + 1 }), "invalid rev"],
    ];
    for (const [input, error] of bad) expect(await store.save(input)).toEqual({ error });
    expect(fs.writes).toBe(0);
  });

  it("refuses a body over 64 MB UTF-8 (multi-byte counted in bytes)", async () => {
    const { store } = setup();
    const max = 64 * 1024 * 1024;
    expect(await store.save(chat({ messages: ["a".repeat(max - 200)] }))).toEqual({ ok: true, rev: 1 });
    expect(await store.save(chat({ rev: 2, messages: ["a".repeat(max)] }))).toEqual({ error: "chat too large" });
    expect(await store.save(chat({ rev: 2, messages: ["é".repeat(max / 2)] }))).toEqual({ error: "chat too large" });
  });

  it("an unserializable body is an error value", async () => {
    const { store } = setup();
    expect(await store.save(chat({ messages: [{ n: 1n }] }))).toEqual({ error: "messages are not serializable" });
  });

  it("serializes concurrent saves of one id", async () => {
    const { store, fs } = setup();
    fs.delay = 5;
    const results = await Promise.all([store.save(chat({ rev: 1 })), store.save(chat({ rev: 1 })), store.save(chat({ rev: 2 })), store.save(chat({ rev: 2 }))]);
    expect(results).toEqual([{ ok: true, rev: 1 }, { ok: true, stale: true, rev: 1 }, { ok: true, rev: 2 }, { ok: true, stale: true, rev: 2 }]);
    expect(fs.writes).toBe(4);
  });

  it("remove deletes both files, tolerates a missing chat, and runs after a pending save", async () => {
    const { store, fs } = setup();
    fs.delay = 5;
    const saving = store.save(chat());
    const removing = store.remove(ID);
    await saving;
    expect(await removing).toEqual({ ok: true });
    expect(fs.files.has(meta(ID))).toBe(false);
    expect(fs.files.has(body(ID))).toBe(false);
    expect(await store.remove("nope")).toEqual({ ok: true });
    expect(await store.remove("../x")).toEqual({ error: "invalid chat id" });
    // After a remove the id can be saved again from rev 1.
    expect(await store.save(chat())).toEqual({ ok: true, rev: 1 });
  });

  it("remove keeps the rev cache and returns an error when an unlink fails", async () => {
    const { store, fs } = setup();
    await store.save(chat({ rev: 5 }));
    const realRemove = fs.remove;
    fs.remove = async (p) => {
      if (p === body(ID)) throw new Error("EACCES");
      return realRemove(p);
    };
    expect(await store.remove(ID)).toEqual({ error: expect.stringContaining("EACCES") });
    // cache kept: an older rev is still stale, nothing written
    const writes = fs.writes;
    expect(await store.save(chat({ rev: 3 }))).toEqual({ ok: true, stale: true, rev: 5 });
    expect(fs.writes).toBe(writes);
    // once the unlink works, the remove succeeds and the cache is dropped
    fs.remove = realRemove;
    expect(await store.remove(ID)).toEqual({ ok: true });
    expect(await store.save(chat({ rev: 1 }))).toEqual({ ok: true, rev: 1 });
  });

  it("list skips invalid, id-mismatched and unparsable metas", async () => {
    const { store, fs } = setup();
    await store.save(chat());
    fs.files.set(meta("bad"), Buffer.from("{nope"));
    fs.files.set(meta("mis"), Buffer.from(JSON.stringify(listed({ id: "other" }))));
    fs.files.set(meta("neg"), Buffer.from(JSON.stringify(listed({ id: "neg", rev: 0 }))));
    fs.files.set(path.join(ROOT, "stranger.txt"), Buffer.from("x"));
    expect(await store.list()).toEqual({ chats: [listed()] });
  });

  it("sweeps temp files older than an hour and keeps fresh ones", async () => {
    const { store, fs, clock } = setup();
    const old = path.join(ROOT, "c1.meta.json.1.ab.tmp");
    const fresh = path.join(ROOT, "c2.chat.json.1.cd.tmp");
    fs.files.set(old, Buffer.from("x"));
    fs.files.set(fresh, Buffer.from("x"));
    fs.mtimes.set(old, clock.t - 2 * 3_600_000);
    fs.mtimes.set(fresh, clock.t - 1000);
    await store.list();
    expect(fs.files.has(old)).toBe(false);
    expect(fs.files.has(fresh)).toBe(true);
  });

  it("a failing write returns an error value and does not advance the rev", async () => {
    const { store, fs } = setup();
    fs.fail = /meta\.json/;
    expect(await store.save(chat())).toEqual({ error: "could not write chat: disk full" });
    fs.fail = undefined;
    expect(await store.save(chat())).toEqual({ ok: true, rev: 1 });
  });

  it("never throws when listing fails", async () => {
    const fs = memFs();
    fs.listFiles = async () => {
      throw new Error("EIO");
    };
    expect(await createChatStore({ rootDir: ROOT, fs }).list()).toEqual({ error: "could not list chats: EIO" });
  });
});
