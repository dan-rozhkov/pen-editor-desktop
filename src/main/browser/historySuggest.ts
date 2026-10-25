/**
 * Address-bar ranking over the history entries (design:
 * docs/superpowers/specs/2026-10-25-browser-history-design.md, "Ranking"). Pure: no I/O, no clock.
 */

export interface SuggestItem {
  url: string;
  title: string;
  lastVisitedAt: number;
}

/** What the ranking reads of a history entry. */
export interface SuggestEntry extends SuggestItem {
  visitCount: number;
}

const DAY_MS = 86400000;

/** The URL without its scheme and a leading `www.`, lowercased: the text a query is matched against. */
function bareUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").toLowerCase();
}

/** Lowercase whitespace-separated query tokens. A typed scheme and `www.` are dropped from a token (the URL side drops them too). */
export function matchTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, ""))
    .filter((t) => t !== "");
}

const matchesTokens = (tokens: string[], title: string, bare: string): boolean => {
  const t = title.toLowerCase();
  return tokens.every((tok) => t.includes(tok) || bare.includes(tok));
};

/** Entries whose title or bare URL contains every query token; order kept. An empty query keeps all. */
export function filterEntries<T extends { url: string; title: string }>(entries: readonly T[], query: string): T[] {
  const tokens = matchTokens(query);
  if (tokens.length === 0) return [...entries];
  return entries.filter((e) => matchesTokens(tokens, e.title, bareUrl(e.url)));
}

const hostOf = (bare: string): string => bare.split(/[/?#]/, 1)[0];

function score(e: SuggestEntry, tokens: string[], whole: string, now: number): number {
  const bare = bareUrl(e.url);
  let s = 0;
  if (hostOf(bare).startsWith(tokens[0])) s += 100;
  if (bare.startsWith(whole)) s += 60;
  const words = e.title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");
  for (const tok of tokens) if (words.some((w) => w.startsWith(tok))) s += 20;
  const ageDays = Math.max(0, (now - e.lastVisitedAt) / DAY_MS);
  return s + Math.log2(1 + e.visitCount) * 10 * (1 / (1 + ageDays / 7));
}

/**
 * The `limit` best entries for `query`. An empty query gives the newest entries; otherwise the matches
 * ranked by match quality plus frecency, ties newest first.
 */
export function suggest(entries: readonly SuggestEntry[], query: string, now: number, limit = 8): SuggestItem[] {
  const tokens = matchTokens(query);
  const toItem = (e: SuggestEntry): SuggestItem => ({ url: e.url, title: e.title, lastVisitedAt: e.lastVisitedAt });
  if (tokens.length === 0) {
    return [...entries].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt).slice(0, limit).map(toItem);
  }
  const whole = tokens.join(" ");
  return entries
    .filter((e) => matchesTokens(tokens, e.title, bareUrl(e.url)))
    .map((e) => ({ e, s: score(e, tokens, whole, now) }))
    .sort((a, b) => b.s - a.s || b.e.lastVisitedAt - a.e.lastVisitedAt)
    .slice(0, limit)
    .map(({ e }) => toItem(e));
}

/**
 * Chrome-style inline completion: the text the address field should show for `typed`, from the top
 * suggestion only. Up to the end of the host, or the whole URL (no trailing slash) once `typed` has a
 * slash. The typed part keeps the user's casing. Null when nothing longer than `typed` completes it.
 */
export function inlineCompletion(items: readonly SuggestItem[], typed: string): string | null {
  if (typed === "" || /\s/.test(typed) || items.length === 0) return null;
  const stripped = items[0].url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "");
  if (!stripped.toLowerCase().startsWith(typed.toLowerCase())) return null;
  let end: number;
  if (typed.includes("/")) {
    end = stripped.length;
    while (end > typed.length && stripped[end - 1] === "/") end--;
  } else {
    const m = stripped.search(/[/?#]/);
    end = m === -1 ? stripped.length : m;
  }
  if (end <= typed.length) return null;
  return typed + stripped.slice(typed.length, end);
}
