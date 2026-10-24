import { describe, expect, it, vi } from "vitest";
import { createKeyedChain, STALE_TMP_MS, sweepStaleTmp } from "../src/main/storeUtils";

describe("createKeyedChain", () => {
  it("runs tasks of one key in order, even when an earlier one rejects", async () => {
    const serialized = createKeyedChain();
    const order: string[] = [];
    const a = serialized("k", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("a");
      throw new Error("a failed");
    });
    const b = serialized("k", async () => void order.push("b"));
    await expect(a).rejects.toThrow("a failed");
    await b;
    expect(order).toEqual(["a", "b"]);
  });

  it("different keys do not wait for each other", async () => {
    const serialized = createKeyedChain();
    const order: string[] = [];
    const slow = serialized("x", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow");
    });
    await serialized("y", async () => void order.push("fast"));
    await slow;
    expect(order).toEqual(["fast", "slow"]);
  });
});

describe("sweepStaleTmp", () => {
  it("removes only old .tmp files and logs a failing removal", async () => {
    const removed: string[] = [];
    const io = {
      read: vi.fn(),
      write: vi.fn(),
      listFiles: vi.fn(),
      remove: vi.fn(async (p: string) => {
        if (p.endsWith("bad.tmp")) throw new Error("denied");
        removed.push(p);
      }),
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const now = 10 * STALE_TMP_MS;
    await sweepStaleTmp(
      io,
      "/r",
      [
        { name: "old.tmp", mtimeMs: now - STALE_TMP_MS - 1 },
        { name: "fresh.tmp", mtimeMs: now - 1000 },
        { name: "a.json", mtimeMs: 0 },
        { name: "bad.tmp", mtimeMs: 0 },
      ],
      () => now,
      "store",
    );
    expect(removed).toEqual(["/r/old.tmp"]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("store: could not sweep bad.tmp"));
    spy.mockRestore();
  });
});
