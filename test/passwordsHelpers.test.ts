import { describe, it, expect } from "vitest";

// Plain global script, loaded with require like urlNormalization.ts (see test/urlNormalization.test.ts).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const h = require("../src/passwords/helpers.ts") as {
  displayHost(origin: string): string;
  matchesQuery(e: { origin: string; username: string; label: string }, q: string): boolean;
  formatLastUsed(ts: number | undefined, now: number): string;
};

describe("displayHost", () => {
  it("drops the scheme and keeps a non-default port", () => {
    expect(h.displayHost("https://example.com")).toBe("example.com");
    expect(h.displayHost("http://localhost:3000")).toBe("localhost:3000");
  });
});

describe("matchesQuery", () => {
  const e = { origin: "https://Github.com", username: "Alice", label: "Work" };
  it("matches host, username and label case-insensitively", () => {
    expect(h.matchesQuery(e, "")).toBe(true);
    expect(h.matchesQuery(e, "  GIT ")).toBe(true);
    expect(h.matchesQuery(e, "alic")).toBe(true);
    expect(h.matchesQuery(e, "wor")).toBe(true);
    expect(h.matchesQuery(e, "nope")).toBe(false);
  });
  it("does not match the scheme", () => {
    expect(h.matchesQuery(e, "https")).toBe(false);
  });
});

describe("formatLastUsed", () => {
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  it("says Never without a timestamp", () => {
    expect(h.formatLastUsed(undefined, now)).toBe("Never");
  });
  it("is relative within a week, a date after", () => {
    expect(h.formatLastUsed(now - 5000, now)).toBe("Just now");
    expect(h.formatLastUsed(now - 60000, now)).toBe("1 minute ago");
    expect(h.formatLastUsed(now - 5 * 60000, now)).toBe("5 minutes ago");
    expect(h.formatLastUsed(now - 3 * 3600000, now)).toBe("3 hours ago");
    expect(h.formatLastUsed(now - 30 * 3600000, now)).toBe("Yesterday");
    expect(h.formatLastUsed(now - 3 * 86400000, now)).toBe("3 days ago");
    expect(h.formatLastUsed(now - 20 * 86400000, now)).toMatch(/2026/);
  });
});

describe("isIconDataUrl", () => {
  const hh = h as unknown as { isIconDataUrl(v: unknown): boolean };
  it("accepts base64 images of allowed types only", () => {
    expect(hh.isIconDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(hh.isIconDataUrl("data:image/svg+xml;base64,AAAA")).toBe(true);
    expect(hh.isIconDataUrl("data:text/html;base64,AAAA")).toBe(false);
    expect(hh.isIconDataUrl("data:image/png;base64,AA<")).toBe(false);
    expect(hh.isIconDataUrl("https://x.com/a.png")).toBe(false);
    expect(hh.isIconDataUrl(5)).toBe(false);
  });
});
