import { describe, expect, it, vi } from "vitest";
import { captureWithRetry } from "../src/main/captureRetry";

type Img = { isEmpty: () => boolean; tag: string };
const img = (empty: boolean, tag = ""): Img => ({ isEmpty: () => empty, tag });
const fn = () => vi.fn<() => Promise<Img>>();

describe("captureWithRetry", () => {
  it("returns the second image when the first is empty", async () => {
    const capture = fn().mockResolvedValueOnce(img(true, "a")).mockResolvedValueOnce(img(false, "b"));
    const wait = vi.fn().mockResolvedValue(undefined);
    const out = await captureWithRetry(capture, wait);
    expect(out.tag).toBe("b");
    expect(wait).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("does not wait or retry when the first image is fine", async () => {
    const capture = fn().mockResolvedValue(img(false, "a"));
    const wait = vi.fn();
    const out = await captureWithRetry(capture, wait);
    expect(out.tag).toBe("a");
    expect(wait).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once and returns the empty second result", async () => {
    const capture = fn().mockResolvedValue(img(true));
    const wait = vi.fn().mockResolvedValue(undefined);
    const out = await captureWithRetry(capture, wait);
    expect(out.isEmpty()).toBe(true);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("still retries when waitForFrame rejects or throws", async () => {
    const capture = fn().mockResolvedValueOnce(img(true)).mockResolvedValueOnce(img(false, "b"));
    expect((await captureWithRetry(capture, () => Promise.reject(new Error("x")))).tag).toBe("b");
    const capture2 = fn().mockResolvedValueOnce(img(true)).mockResolvedValueOnce(img(false, "c"));
    expect(
      (
        await captureWithRetry(capture2, () => {
          throw new Error("y");
        })
      ).tag,
    ).toBe("c");
  });
});
