import { describe, it, expect } from "vitest";

// Plain global script, loaded with require like urlNormalization.ts (see test/urlNormalization.test.ts).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const h = require("../src/passwords/helpers.ts") as {
  displayHost(origin: string): string;
  matchesQuery(e: { origin: string; username: string; label: string }, q: string): boolean;
  duplicateHosts(origins: string[]): string[];
  rowSuffixes(e: { id: string; origin: string; username: string; label: string }[]): Map<string, string>;
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

describe("duplicateHosts", () => {
  it("returns hosts shown by two or more logins, once each, case-insensitively", () => {
    expect(h.duplicateHosts(["https://github.com", "https://a.com", "https://GitHub.com", "https://github.com"])).toEqual(["github.com"]);
  });
  it("is empty when every site is unique; scheme and port are part of the shown name", () => {
    expect(h.duplicateHosts(["https://a.com", "http://a.com:3000", "https://b.com"])).toEqual([]);
    expect(h.duplicateHosts([])).toEqual([]);
  });
  it("treats http and https of one host as the same displayed name", () => {
    expect(h.duplicateHosts(["https://a.com", "http://a.com"])).toEqual(["a.com"]);
  });
});

describe("duplicateHosts prototype keys", () => {
  it("does not break on hosts named like Object.prototype keys", () => {
    expect(h.duplicateHosts(["https://constructor", "https://constructor", "https://__proto__"])).toEqual(["constructor"]);
  });
});

describe("rowSuffixes", () => {
  const e = (id: string, origin: string, username: string, label = "") => ({ id, origin, username, label });
  it("gives no suffix to unique hosts and the username to shared ones", () => {
    const m = h.rowSuffixes([e("1", "https://a.com", "x"), e("2", "https://b.com", "y"), e("3", "https://b.com", "z")]);
    expect(m.has("1")).toBe(false);
    expect(m.get("2")).toBe("y");
    expect(m.get("3")).toBe("z");
  });
  it("adds the label when host and username clash and labels differ", () => {
    const m = h.rowSuffixes([e("1", "https://a.com", "x", "Work"), e("2", "http://a.com", "x", "Home")]);
    expect(m.get("1")).toBe("x \u00b7 Work");
    expect(m.get("2")).toBe("x \u00b7 Home");
  });
  it("falls back to the full origin when labels do not tell them apart", () => {
    const m = h.rowSuffixes([e("1", "https://a.com", "x"), e("2", "http://a.com", "X")]);
    expect(m.get("1")).toBe("x \u00b7 https://a.com");
    expect(m.get("2")).toBe("X \u00b7 http://a.com");
  });
});
