# Browser history: address-bar suggestions + History tab

Date: 2026-10-25. Status: approved (autopilot run, decisions are the agent's call).

## Intent

The built-in browser forgets every page. The user wants it to work like a real
browser: the address field suggests pages visited before, filters them while the
user types, and a separate History tab lists all visited pages (opened like the
Passwords tab).

## Prior art (research, 25.10)

- Chrome omnibox: a plain, low-distraction dropdown; inline autocomplete of the
  top match runs synchronously so it does not flicker; the top row does not move
  as results change; Shift+Delete removes a history row.
- Firefox: rank by "frecency" (frequency + recency).
- Arc Command Bar / Raycast: one keyboard-first list, title first and URL muted,
  arrow keys + Enter, no mouse needed.
- Notion Quick Find: on open with an empty query it shows recently visited pages
  at once; typing filters the same list.
- Chrome/Safari history page: one search field at the top, rows grouped by day
  ("Today", "Yesterday", date), time at the left, remove per row, "Clear history".

## Goals

1. Record every top-level navigation of a user browser tab (default
   `persist:penbrowser` session) to `<userData>/browser-history.json`.
2. Address field popover: on focus with an empty or unchanged field, show the 8
   most recent pages. While typing, show up to 8 matches ranked by
   match quality, then frecency. Arrow keys move the selection, Enter opens,
   Esc closes, Shift+Delete / Shift+Backspace removes the selected row, a click
   opens. Inline autocomplete of a host prefix (Chrome style).
3. History tab: singleton per window, local page, opened by File ▸ History…
   (`CmdOrCtrl+Y`), by the Browser tools "⋮" menu, and by the popover footer
   "Show all history". Search field, rows grouped by day, remove per row,
   "Clear history…" with a native confirm. A click opens the page in a new
   browser tab.

## Non-goals

- No sync to the backend or the frontend. History stays local to the desktop.
- No per-visit log: one entry per URL (`visitCount`, `lastVisitedAt`). The
  History tab groups by `lastVisitedAt`.
- No favicons in v1 (the favicon cache keeps icons only for origins with a
  saved login). Rows show a neutral Phosphor Globe glyph.
- No search-engine suggestions.

## Anti-goals

- Isolated QA sessions (`qa-0`..`qa-5`) and the agent's isolated runs never write
  history. They run in throwaway partitions on purpose.
- No URL with credentials (`user:pass@`), no non-http(s) URL, no offline
  fallback page is stored.
- The popover must never steal keystrokes from the address field.

## Design

### Store — `src/main/browser/historyStore.ts` (pure, fs port injected)

- File `browser-history.json` in userData (`browser-history-dev.json` is NOT
  needed: the browser partition is shared between dev and prod already).
  Shape `{ version: 1, entries: HistoryEntry[] }`,
  `HistoryEntry = { url, title, visitCount, lastVisitedAt }` (ms epoch).
- Key = the URL with its hash removed. `recordVisit(url, now)` bumps
  `visitCount` and `lastVisitedAt`, `setTitle(url, title)` updates the title
  (trimmed, <= 300 chars). `remove(url)`, `clear()`, `list()` newest first.
- Cap 5000 entries: drop the oldest by `lastVisitedAt`.
- Writes are debounced (500 ms) and written tmp + rename, mode 0o600;
  `flush()` on quit. A corrupt file loads as empty (and is not overwritten
  until the next change).
- `onChange` listeners for the History tab refresh.

### Ranking — `src/main/browser/historySuggest.ts` (pure)

- `suggest(entries, query, now, limit = 8)`.
- Empty query: the newest `limit` entries.
- Otherwise split the query on whitespace into lowercase tokens. An entry
  matches when every token is a substring of its title or of its URL without
  the scheme and a leading `www.`. Score: host starts with the first token (+100),
  URL-without-scheme starts with the whole query (+60), a title word starts with a
  token (+20 per token), plus frecency `log2(1 + visitCount) * 10 * decay`, where
  `decay = 1 / (1 + ageDays / 7)`. Ties: newer first.
- `inlineCompletion(entries, typed)`: if `typed` has no whitespace, does not end
  with a deletion (the caller passes that), and a ranked match's URL without the
  scheme and `www.` starts with `typed`, return the completion up to the end of
  the host (or the whole such URL when `typed` already contains a `/`).
- Match ranges for highlighting: `highlightRanges(text, tokens)`.

### Popover (omnibox) — separate `WebContentsView`

An HTML popup inside the tab bar view would be clipped to its height (same reason
the menus are native). So each main window owns one hidden popup view loading a
local page `dist/omnibox/omnibox.html` with `preload/omnibox.js`
(`contextIsolation`, `sandbox`, `attachLocalOnlyPolicy`, transparent
background). When shown it is re-added as the top-most child and placed below
the URL field.

The tab bar renderer owns the state (query, items, selection) and all keys; the
popup only paints and reports clicks.

IPC (all sender-checked):
- `history:suggest` tabbar->main **invoke** `{query}` -> `{items: {url, title}[], inline: string | null}`.
- `tabbar:omnibox-show` tabbar->main `{items, selected, rect: {x, y, width}}`,
  `tabbar:omnibox-hide` tabbar->main. Main sizes the popup
  (`omniboxBounds` in `layout.ts`, pure: rows * 40 + header/footer + shadow
  padding, clamped to the window) and forwards `omnibox:render`
  `{items, selected, theme, query}` to the popup.
- `omnibox:pick` popup->main `{url}`: accepted only when the url is one of the
  items last forwarded. Main navigates the active browser tab and sends
  `tabbar:omnibox-picked` `{url}` to the tab bar (it closes the popup, shows
  the url, blurs the field).
- `omnibox:remove` popup->main `{url}` (the row's "x" on hover) and
  `history:remove-suggestion` tabbar->main `{url}` (Shift+Delete): remove from the
  store, then `tabbar:omnibox-refresh` to the tab bar (it re-queries).
- `omnibox:open-history` popup->main: opens the History tab.

Look: island colour (`#ffffff` light / `#2a2a2a` dark), radius 12, 1px border
`--border`, soft shadow, 4px inner padding. Row 40px: Globe glyph 16px, title
13px `--text-active` with matched ranges in weight 600, then a muted URL (host +
path, ellipsis), relative time on the right ("2 h", "Yesterday"). Selected row:
`--btn-hover` fill, radius `--btn-radius`. Empty query shows a small "Recent"
header. Footer row: "Show all history" + "⌘Y" hint. No rows -> popup hidden.

### History tab

- `TabKind` `"history"`, singleton like Passwords (`openHistoryTab`,
  `findHistoryTab`), title "History", tab icon Phosphor "ClockCounterClockwise"
  (light). Not a page tab, not an editor theme source, no file target, no
  address row.
- Local page `src/history/` (plain-script renderer, CSP `default-src 'none'`,
  same tokens as Passwords), preload `src/preload/history.ts` exposing
  `window.penHistory = { list, remove, clear, open, onChanged, onTheme }`.
- Service `src/main/historyService.ts` (pure, ports injected, like
  `passwordsService.ts`): invoke `history:list` `{query?}` -> `{entries}`
  (filtered with the same token rule, newest first, max 1000 rendered),
  `history:remove` `{url}`, `history:clear` (native confirm on the owning window,
  Cancel default) and `history:open` `{url}` (new browser tab, activated).
  Main->page: `history:theme` `{theme}`, `history:changed`.
- Layout: max-width 760 centered; header "History" + search field + "Clear
  history…" button; sections per day with a sticky muted label; rows 40px with
  time (HH:MM), Globe glyph, title, muted host, remove "x" on hover/focus.
  Empty state: "No history yet" / "No pages match “…”".

### Recording

In `window.ts`, for `kind === "browser"` tabs WITHOUT `sessionId`:
`did-navigate` and `did-navigate-in-page` (main frame) -> `recordVisit`;
`page-title-updated` -> `setTitle(currentUrl, title)`. The offline fallback page
(a `file:` URL) is filtered by the http(s) rule.

## Tests

Unit: historyStore, historySuggest, historyService, omniboxBounds, the tab bar's
pure keyboard helpers, menu (History… item), tabManager (history singleton),
ipcContract channels. E2E: `browser-history.spec.ts` (visit two stub pages,
focus the address field, popup shows them, type filters, Enter navigates,
History tab lists them, remove works).
