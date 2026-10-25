import { describe, expect, it } from "vitest";
import { filterEntries, inlineCompletion, matchTokens, suggest, type SuggestEntry } from "../src/main/browser/historySuggest";

const NOW = 100 * 86400000;
const DAY = 86400000;
const e = (url: string, title: string, visitCount: number, ageDays: number): SuggestEntry => ({ url, title, visitCount, lastVisitedAt: NOW - ageDays * DAY });
const urls = (items: { url: string }[]) => items.map((i) => i.url);

describe("matchTokens", () => {
  it("lowercases, splits on whitespace and drops a typed scheme / www.", () => {
    expect(matchTokens("  Foo   BAR ")).toEqual(["foo", "bar"]);
    expect(matchTokens("https://www.GitHub.com/x")).toEqual(["github.com/x"]);
    expect(matchTokens("   ")).toEqual([]);
  });
});

describe("filterEntries", () => {
  const all = [e("https://www.github.com/a", "Repo", 1, 0), e("https://news.com/", "GitHub news", 1, 1), e("https://other.com/", "Other", 1, 2)];
  it("needs every token in the title or the bare URL", () => {
    expect(urls(filterEntries(all, "github"))).toEqual(["https://www.github.com/a", "https://news.com/"]);
    expect(urls(filterEntries(all, "github news"))).toEqual(["https://news.com/"]);
    expect(filterEntries(all, "zzz")).toEqual([]);
  });
  it("does not match the scheme or www.", () => {
    expect(filterEntries(all, "https")).toEqual([]);
    expect(filterEntries(all, "www")).toEqual([]);
  });
  it("keeps everything for an empty query", () => {
    expect(filterEntries(all, "")).toHaveLength(3);
  });
});

describe("suggest", () => {
  it("returns the newest entries for an empty query", () => {
    const entries = [e("https://a.com/", "A", 50, 5), e("https://b.com/", "B", 1, 0), e("https://c.com/", "C", 1, 2)];
    expect(urls(suggest(entries, "", NOW, 2))).toEqual(["https://b.com/", "https://c.com/"]);
  });

  it("defaults to eight results", () => {
    const entries = Array.from({ length: 12 }, (_, i) => e(`https://h${i}.com/`, "t", 1, i));
    expect(suggest(entries, "", NOW)).toHaveLength(8);
  });

  it("ranks a host prefix above a title match", () => {
    const entries = [e("https://blog.com/p", "All about github", 30, 0), e("https://github.com/", "Home", 1, 30)];
    expect(urls(suggest(entries, "git", NOW))).toEqual(["https://github.com/", "https://blog.com/p"]);
  });

  it("breaks ties with frecency, then recency", () => {
    const entries = [
      e("https://x.com/one", "foo", 1, 0),
      e("https://x.com/two", "foo", 20, 0),
      e("https://x.com/old", "foo", 20, 60),
    ];
    expect(urls(suggest(entries, "foo", NOW))).toEqual(["https://x.com/two", "https://x.com/one", "https://x.com/old"]);
  });

  it("requires every token to match", () => {
    const entries = [e("https://a.com/docs", "Guide", 1, 0), e("https://a.com/", "Home", 1, 0)];
    expect(urls(suggest(entries, "a.com guide", NOW))).toEqual(["https://a.com/docs"]);
  });

  it("matches ignoring case, the scheme and www.", () => {
    const entries = [e("https://www.Example.com/Path", "T", 1, 0)];
    expect(suggest(entries, "EXAMPLE.com/p", NOW)).toHaveLength(1);
    expect(suggest(entries, "https://www.example", NOW)).toHaveLength(1);
  });

  it("prefers a whole-query URL prefix and title-word starts", () => {
    const entries = [e("https://a.com/", "my notes app", 1, 0), e("https://notes.org/", "Other", 1, 0), e("https://z.com/x", "unrelated notes", 1, 0)];
    expect(urls(suggest(entries, "notes", NOW))[0]).toBe("https://notes.org/");
    expect(urls(suggest(entries, "notes", NOW))).toHaveLength(3);
  });

  it("returns items with only url, title, lastVisitedAt", () => {
    expect(suggest([e("https://a.com/", "A", 3, 0)], "a", NOW)[0]).toEqual({ url: "https://a.com/", title: "A", lastVisitedAt: NOW });
  });
});

describe("inlineCompletion", () => {
  const item = (url: string) => [{ url, title: "", lastVisitedAt: 0 }];
  it("completes to the end of the host, keeping the typed casing", () => {
    expect(inlineCompletion(item("https://www.github.com/org/repo"), "gi")).toBe("github.com");
    expect(inlineCompletion(item("https://github.com/org"), "GitH")).toBe("GitHub.com");
  });
  it("completes the whole URL once typed has a slash, without a trailing slash", () => {
    expect(inlineCompletion(item("https://github.com/org/repo"), "github.com/o")).toBe("github.com/org/repo");
    expect(inlineCompletion(item("https://github.com/org/"), "github.com/o")).toBe("github.com/org");
  });
  it("returns null when nothing longer completes", () => {
    expect(inlineCompletion(item("https://github.com/org"), "github.com")).toBeNull();
    expect(inlineCompletion(item("https://github.com/"), "github.com/")).toBeNull();
    expect(inlineCompletion(item("https://github.com/org"), "gitlab")).toBeNull();
  });
  it("returns null for typed with whitespace, empty typed or no items", () => {
    expect(inlineCompletion(item("https://github.com/"), "git hub")).toBeNull();
    expect(inlineCompletion(item("https://github.com/"), "")).toBeNull();
    expect(inlineCompletion([], "git")).toBeNull();
  });
  it("only considers the top item", () => {
    const items = [...item("https://other.com/"), ...item("https://github.com/")];
    expect(inlineCompletion(items, "git")).toBeNull();
  });
  it("keeps a port inside the host", () => {
    expect(inlineCompletion(item("http://localhost:3000/app"), "local")).toBe("localhost:3000");
  });
});
