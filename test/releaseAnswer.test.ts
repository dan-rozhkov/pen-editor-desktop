import { describe, expect, it } from "vitest";
import { releaseAnswer } from "../src/main/releaseAnswer";

describe("releaseAnswer", () => {
  it("forwards mockHits", () => {
    const mockHits = [{ method: "GET", url: "/api/x", hits: 0 }, { url: "/y", hits: 2 }];
    expect(releaseAnswer({ mockHits })).toEqual({ ok: true, mockHits });
  });
  it("answers a bare ok for void, null, junk or a non-array mockHits", () => {
    for (const r of [undefined, null, "x", 3, {}, { mockHits: "no" }, { mockHits: {} }]) {
      expect(releaseAnswer(r)).toEqual({ ok: true });
    }
  });
});
