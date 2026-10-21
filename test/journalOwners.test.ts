import { beforeEach, describe, expect, it, vi } from "vitest";
import { JournalOwners } from "../src/main/journalOwners";

function setup() {
  let n = 0;
  const controller = {
    startJournal: vi.fn((_opts?: { origins?: string[] }) => `tok${++n}`),
    stopJournal: vi.fn((_token?: string) => true),
    captureCheckpoint: vi.fn(async (_token?: string) => ({ ok: true })),
  };
  const clock = { t: T0 };
  return { controller, clock, owners: new JournalOwners(controller, () => clock.t) };
}
const live = () => true;
const T0 = 1_000_000;

describe("JournalOwners", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("start records the owner and passes origins", () => {
    expect(s.owners.start(1, live, ["https://a.test"])).toBe("tok1");
    expect(s.controller.startJournal).toHaveBeenCalledWith({ origins: ["https://a.test"] });
    s.owners.start(1, live);
    expect(s.controller.startJournal).toHaveBeenLastCalledWith(undefined);
  });

  it("refuses a start while another live tab owns a journal, without calling the controller", () => {
    s.owners.start(1, live);
    const r = s.owners.start(2, live);
    expect(r).toEqual({ error: "another editor tab is recording a checkpoint" });
    expect(s.controller.startJournal).toHaveBeenCalledTimes(1);
  });

  it("lets the owner restart; the old token becomes unusable", async () => {
    const t1 = s.owners.start(1, live) as string;
    const t2 = s.owners.start(1, live) as string;
    expect(t2).not.toBe(t1);
    expect(s.owners.stop(1, t1)).toBe(false);
    expect((await s.owners.capture(1, t1) as { ok: boolean }).ok).toBe(false);
    expect(s.owners.stop(1, t2)).toBe(true);
  });

  it("lets another tab start when the owner is no longer live (stale mapping)", () => {
    const t1 = s.owners.start(1, live) as string;
    const t2 = s.owners.start(2, (id) => id !== 1);
    expect(t2).toBe("tok2");
    expect(s.owners.stop(1, t1)).toBe(false);
    expect(s.owners.stop(2, t2 as string)).toBe(true);
  });

  it("stop refuses a foreign or missing token and does not call the controller", () => {
    const t = s.owners.start(1, live) as string;
    expect(s.owners.stop(2, t)).toBe(false);
    expect(s.owners.stop(1, undefined)).toBe(false);
    expect(s.owners.stop(1, "nope")).toBe(false);
    expect(s.controller.stopJournal).not.toHaveBeenCalled();
    expect(s.owners.stop(1, t)).toBe(true);
    expect(s.controller.stopJournal).toHaveBeenCalledWith(t);
    expect(s.owners.stop(1, t)).toBe(false); // mapping dropped
  });

  it("capture refuses a foreign or missing token", async () => {
    const t = s.owners.start(1, live) as string;
    for (const [who, tok] of [[2, t], [1, undefined], [1, "nope"]] as const) {
      const r = (await s.owners.capture(who, tok)) as { ok: boolean; error: string };
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe("string");
    }
    expect(s.controller.captureCheckpoint).not.toHaveBeenCalled();
    expect(await s.owners.capture(1, t)).toEqual({ ok: true });
    expect(s.controller.captureCheckpoint).toHaveBeenCalledWith(t);
  });

  it("stopOwnedBy stops only the sender's journal, always with a token", () => {
    const t = s.owners.start(1, live) as string;
    s.owners.stopOwnedBy(2);
    expect(s.controller.stopJournal).not.toHaveBeenCalled();
    s.owners.stopOwnedBy(1);
    expect(s.controller.stopJournal).toHaveBeenCalledTimes(1);
    expect(s.controller.stopJournal).toHaveBeenCalledWith(t);
    s.owners.stopOwnedBy(1);
    expect(s.controller.stopJournal).toHaveBeenCalledTimes(1);
    expect(s.owners.start(2, live)).toBe("tok2");
  });

  it("beforeCommand stops a foreign live journal on a page-changing command", async () => {
    const t = s.owners.start(1, live) as string;
    s.owners.beforeCommand(2, "act", {}, live);
    expect(s.controller.stopJournal).toHaveBeenCalledWith(t);
    expect((await s.owners.capture(1, t) as { ok: boolean }).ok).toBe(false);
    expect(s.owners.start(2, live)).toBe("tok2"); // lock is free
  });

  it("beforeCommand leaves the journal alone for the owner, read-only commands, tabs list and dead owners", () => {
    s.owners.start(1, live);
    s.owners.beforeCommand(1, "act", {}, live);
    for (const c of ["snapshot", "read", "screenshot", "findImages", "capture", "captureCheckpoint", "stopJournal", "requests"]) {
      s.owners.beforeCommand(2, c, undefined, live);
    }
    s.owners.beforeCommand(2, "tabs", { action: "list" }, live);
    s.owners.beforeCommand(2, "act", {}, (id) => id !== 1);
    expect(s.controller.stopJournal).not.toHaveBeenCalled();
  });

  it("beforeCommand treats tabs non-list actions (and missing args) as page-changing", () => {
    s.owners.start(1, live);
    s.owners.beforeCommand(2, "tabs", { action: "switch" }, live);
    expect(s.controller.stopJournal).toHaveBeenCalledTimes(1);
    s.owners.start(1, live);
    s.owners.beforeCommand(2, "tabs", undefined, live);
    expect(s.controller.stopJournal).toHaveBeenCalledTimes(2);
  });

  it("beforeCommand without a journal does nothing", () => {
    s.owners.beforeCommand(2, "act", {}, live);
    expect(s.controller.stopJournal).not.toHaveBeenCalled();
  });

  it("another tab may take over a journal older than 20 minutes, stopping the old one first", () => {
    const t1 = s.owners.start(1, live) as string;
    s.clock.t = T0 + 20 * 60 * 1000;
    expect(s.owners.start(2, live)).toEqual({ error: "another editor tab is recording a checkpoint" });
    s.clock.t = T0 + 20 * 60 * 1000 + 1;
    expect(s.owners.start(2, live)).toBe("tok2");
    expect(s.controller.stopJournal).toHaveBeenCalledWith(t1);
    expect(s.owners.stop(1, t1)).toBe(false);
  });
});
