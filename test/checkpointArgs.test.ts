import { describe, expect, it } from "vitest";
import { parseJournalOrigins, parseToken, rawToken } from "../src/main/checkpointArgs";

describe("parseJournalOrigins", () => {
  it("accepts an array of short strings", () => {
    expect(parseJournalOrigins({ origins: ["https://a.test", "https://b.test"] })).toEqual({ ok: true, origins: ["https://a.test", "https://b.test"] });
  });
  it("accepts an empty array (no origins)", () => {
    expect(parseJournalOrigins({ origins: [] })).toEqual({ ok: true, origins: [] });
  });
  it("absent origins or non-record args mean defaults", () => {
    for (const a of [undefined, null, [], {}, { origins: undefined }]) {
      expect(parseJournalOrigins(a)).toEqual({ ok: true, origins: undefined });
    }
  });
  it("rejects a non-array origins", () => {
    expect(parseJournalOrigins({ origins: "https://a.test" })).toEqual({ ok: false });
    expect(parseJournalOrigins({ origins: null })).toEqual({ ok: false });
  });
  it("rejects more than 20 origins (20 passes)", () => {
    expect(parseJournalOrigins({ origins: Array(20).fill("https://a.test") })).toMatchObject({ ok: true });
    expect(parseJournalOrigins({ origins: Array(21).fill("https://a.test") })).toEqual({ ok: false });
  });
  it("rejects a non-string or over-long (512 ok, 513 not) item", () => {
    expect(parseJournalOrigins({ origins: ["a".repeat(512)] })).toMatchObject({ ok: true });
    expect(parseJournalOrigins({ origins: ["a".repeat(513)] })).toEqual({ ok: false });
    expect(parseJournalOrigins({ origins: ["https://a.test", 5] })).toEqual({ ok: false });
  });
});

describe("rawToken", () => {
  it("passes a string through with no length cap", () => {
    expect(rawToken({ token: "t" })).toBe("t");
    expect(rawToken({ token: "a".repeat(5000) })).toHaveLength(5000);
  });
  it("is undefined only for a non-string or missing token", () => {
    expect(rawToken({ token: 1 })).toBeUndefined();
    expect(rawToken({})).toBeUndefined();
    expect(rawToken(undefined)).toBeUndefined();
  });
});

describe("parseToken", () => {
  it("accepts a string up to 512 chars", () => {
    expect(parseToken({ token: "t" })).toBe("t");
    expect(parseToken({ token: "a".repeat(512) })).toHaveLength(512);
  });
  it("ignores everything else", () => {
    expect(parseToken({ token: "a".repeat(513) })).toBeUndefined();
    expect(parseToken({ token: 1 })).toBeUndefined();
    expect(parseToken({})).toBeUndefined();
    expect(parseToken(undefined)).toBeUndefined();
    expect(parseToken("tok")).toBeUndefined();
  });
});
