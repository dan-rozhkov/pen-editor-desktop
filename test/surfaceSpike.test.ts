import { beforeEach, describe, expect, it } from "vitest";
import { SurfaceSpikeRouter, type SpikeDelivered, type SpikeEnvelope } from "../src/main/surfaceSpike";

const CHAT = 10;
const CANVAS = 20;
const OUTSIDER = 99;

let editors: Set<number>;
let sent: { to: number; d: SpikeDelivered }[];
let clock: number;
let router: SurfaceSpikeRouter;

const env = (id: string, msg: SpikeEnvelope["msg"] = { kind: "context-request", reqId: id }): SpikeEnvelope => ({
  id,
  sentAt: 1,
  msg,
});
const to = (id: number) => sent.filter((s) => s.to === id).map((s) => s.d);

beforeEach(() => {
  editors = new Set([CHAT, CANVAS]);
  sent = [];
  clock = 1000;
  router = new SurfaceSpikeRouter({
    isEditorTab: (id) => editors.has(id),
    deliver: (id, d) => sent.push({ to: id, d }),
    now: () => clock++,
  });
  router.setRole(CHAT, "chat");
  router.setRole(CANVAS, "canvas");
});

describe("SurfaceSpikeRouter", () => {
  it("forwards chat -> canvas and canvas -> chat, stamping relayedAt", () => {
    router.post(CHAT, env("a"));
    router.post(CANVAS, env("b"));
    expect(to(CANVAS)).toEqual([{ id: "a", sentAt: 1, msg: { kind: "context-request", reqId: "a" }, relayedAt: 1000 }]);
    expect(to(CHAT)).toEqual([{ id: "b", sentAt: 1, msg: { kind: "context-request", reqId: "b" }, relayedAt: 1001 }]);
  });

  it("answers an error to the sender when no peer holds the other role", () => {
    router.setRole(CANVAS, null);
    sent = [];
    router.post(CHAT, env("a"));
    expect(to(CANVAS)).toEqual([]);
    expect(to(CHAT)).toHaveLength(1);
    expect(to(CHAT)[0].msg).toEqual({ kind: "error", refId: "a", error: "no canvas tab" });
  });

  it("errors for a sender without a role", () => {
    router.setRole(CHAT, null);
    sent = [];
    router.post(CHAT, env("a"));
    expect(to(CHAT)[0].msg).toEqual({ kind: "error", refId: "a", error: "no role set" });
  });

  it("a new setRole replaces the old holder and the other side sees peer-gone", () => {
    editors.add(30);
    sent = [];
    router.setRole(30, "canvas");
    expect(router.roleOf(CANVAS)).toBeNull();
    expect(router.roleOf(30)).toBe("canvas");
    expect(to(CHAT).map((d) => d.msg)).toEqual([{ kind: "peer-gone", role: "canvas" }]);
    router.post(CHAT, env("a"));
    expect(to(30)).toHaveLength(1);
    expect(to(CANVAS)).toEqual([]);
  });

  it("switching a tab from one role to the other releases the first role", () => {
    sent = [];
    router.setRole(CHAT, "canvas");
    expect(router.roleOf(CHAT)).toBe("canvas");
    expect(router.roleOf(CANVAS)).toBeNull();
    // Releasing "chat" tells the old canvas holder (about to be displaced) peer-gone.
    expect(to(CANVAS).map((d) => d.msg)).toEqual([{ kind: "peer-gone", role: "chat" }]);
  });

  it("repeating the same role is a no-op", () => {
    sent = [];
    router.setRole(CHAT, "chat");
    expect(sent).toEqual([]);
    expect(router.roleOf(CHAT)).toBe("chat");
  });

  it("delivers peer-gone to the other side when a tab is destroyed", () => {
    sent = [];
    router.tabGone(CANVAS);
    expect(sent.map((s) => [s.to, s.d.msg])).toEqual([[CHAT, { kind: "peer-gone", role: "canvas" }]]);
    router.tabGone(CANVAS);
    expect(sent).toHaveLength(1);
  });

  it("delivers peer-gone on setRole(null) and on an invalid role", () => {
    sent = [];
    router.setRole(CHAT, null);
    expect(sent.map((s) => [s.to, s.d.msg])).toEqual([[CANVAS, { kind: "peer-gone", role: "chat" }]]);
    router.setRole(CANVAS, "bogus");
    expect(router.roleOf(CANVAS)).toBeNull();
  });

  it("rejects a sender that is not a registered editor tab", () => {
    router.setRole(OUTSIDER, "chat");
    expect(router.roleOf(OUTSIDER)).toBeNull();
    expect(router.roleOf(CHAT)).toBe("chat");
    sent = [];
    router.post(OUTSIDER, env("a"));
    expect(sent).toEqual([]);
  });

  it("drops a holder that stopped being an editor tab instead of delivering to it", () => {
    editors.delete(CANVAS);
    sent = [];
    router.post(CHAT, env("a"));
    expect(to(CANVAS)).toEqual([]);
    expect(to(CHAT)[0].msg).toMatchObject({ kind: "error", refId: "a" });
  });

  it("drops malformed envelopes and main-only kinds posted by tabs", () => {
    sent = [];
    router.post(CHAT, null);
    router.post(CHAT, { id: 1, sentAt: 1, msg: { kind: "x" } });
    router.post(CHAT, { id: "a", sentAt: 1, msg: {} });
    router.post(CHAT, env("e", { kind: "error", refId: "x", error: "spoof" }));
    router.post(CHAT, env("p", { kind: "peer-gone", role: "chat" }));
    expect(sent).toEqual([]);
  });

  it("preserves the order of many posts", () => {
    for (let i = 0; i < 500; i++) router.post(CHAT, env(`m${i}`, { kind: "stream", seq: i }));
    expect(to(CANVAS).map((d) => d.id)).toEqual(Array.from({ length: 500 }, (_, i) => `m${i}`));
    const stamps = to(CANVAS).map((d) => d.relayedAt);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it("dispose clears roles silently", () => {
    sent = [];
    router.dispose();
    expect(sent).toEqual([]);
    expect(router.roleOf(CHAT)).toBeNull();
  });
});
