import { describe, expect, it, vi } from "vitest";
import { createNativeHandle } from "../src/main/computerUse/nativeHandle";
import { HelperError, type HelperEvent } from "../src/main/computerUse/helperClient";

function setup() {
  const eventCbs = new Set<(e: HelperEvent) => void>();
  const exitCbs = new Set<(c: number | null) => void>();
  const call = vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => ({}) as Record<string, unknown>);
  const helper = {
    call,
    onEvent: (cb: (e: HelperEvent) => void) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    onExit: (cb: (c: number | null) => void) => (exitCbs.add(cb), () => exitCbs.delete(cb)),
  };
  const overlay = { moveTo: vi.fn(), destroy: vi.fn() };
  const kill = vi.spyOn(process, "kill");
  return { helper, call, overlay, eventCbs, exitCbs, kill, deps: { helper, pid: 4242, appPath: "/Applications/Notes.app", describe: async () => ({ name: "Notes", bundleId: "com.apple.Notes" }), overlay } };
}

describe("createNativeHandle", () => {
  it("is pid-less and native, watches the pid", async () => {
    const s = setup();
    const h = await createNativeHandle(s.deps);
    expect(h.native).toBe(true);
    expect(h.pid).toBeUndefined();
    expect(h.userProfile).toBe(false);
    expect(h.profileDir).toBeNull();
    expect(h.name).toBe("Notes");
    expect(s.call).toHaveBeenCalledWith("watch", { pid: 4242 });
  });

  it("a failed watch fails the launch and tears down (app quit during the confirm)", async () => {
    const s = setup();
    s.call.mockImplementation(async (cmd: string) => {
      if (cmd === "watch") throw new HelperError("no such pid", "NOT_FOUND");
      return {};
    });
    await expect(createNativeHandle(s.deps)).rejects.toThrow("The app quit right after it launched.");
    expect(s.overlay.destroy).toHaveBeenCalled();
    expect(s.eventCbs.size).toBe(0);
    expect(s.exitCbs.size).toBe(0);
  });

  it("a watch that fails for another reason also fails the launch", async () => {
    const s = setup();
    s.call.mockImplementation(async (cmd: string) => {
      if (cmd === "watch") throw new HelperError("boom", "TIMEOUT");
      return {};
    });
    await expect(createNativeHandle(s.deps)).rejects.toThrow(/boom/);
  });

  it("appTerminated for its pid fires onDisconnected once; other pids do not", async () => {
    const s = setup();
    const h = await createNativeHandle(s.deps);
    const cb = vi.fn();
    h.onDisconnected(cb);
    for (const f of s.eventCbs) f({ event: "appTerminated", pid: 1 });
    expect(cb).not.toHaveBeenCalled();
    for (const f of s.eventCbs) f({ event: "appTerminated", pid: 4242 });
    for (const f of s.eventCbs) f({ event: "appTerminated", pid: 4242 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(h.disconnected).toBe(true);
    const late = vi.fn();
    h.onDisconnected(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("helper exit fires onDisconnected", async () => {
    const s = setup();
    const h = await createNativeHandle(s.deps);
    const cb = vi.fn();
    h.onDisconnected(cb);
    for (const f of s.exitCbs) f(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("close only removes the overlay: no signal, no quit command, idempotent", async () => {
    const s = setup();
    const h = await createNativeHandle(s.deps);
    s.call.mockClear();
    await h.close();
    await h.close();
    expect(s.overlay.destroy).toHaveBeenCalledTimes(1);
    expect(s.kill).not.toHaveBeenCalled();
    expect(s.call).not.toHaveBeenCalled();
    expect(s.eventCbs.size).toBe(0);
    expect(s.exitCbs.size).toBe(0);
  });

  it("destroyOverlay (quit path) only destroys the overlay", async () => {
    const s = setup();
    const h = await createNativeHandle(s.deps);
    s.call.mockClear();
    h.destroyOverlay();
    expect(s.overlay.destroy).toHaveBeenCalledTimes(1);
    expect(s.kill).not.toHaveBeenCalled();
    expect(s.call).not.toHaveBeenCalled();
  });
});
