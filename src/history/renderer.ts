// Plain script (no import/export): it runs from a CSP'd <script src>, like src/passwords/renderer.ts.
// Wrapped in a function so its names do not collide with the other scripts' globals when they are
// compiled in one program. Text goes in through textContent only, never innerHTML.
(function historyRenderer() {
  interface Entry {
    url: string;
    title: string;
    visitCount: number;
    lastVisitedAt: number;
  }
  type ListResult = { entries: Entry[] } | { ok: false };
  type ClearResult = { ok: boolean; cancelled?: boolean };
  interface PenHistoryApi {
    list(query?: string): Promise<ListResult>;
    remove(url: string): Promise<unknown>;
    clear(): Promise<ClearResult>;
    open(url: string): Promise<unknown>;
    onTheme(cb: (payload: { theme: "light" | "dark" }) => void): void;
    onChanged(cb: () => void): void;
  }

  const api = (window as unknown as { penHistory: PenHistoryApi }).penHistory;
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

  api.onTheme(({ theme }) => {
    document.documentElement.dataset.theme = theme;
  });

  const searchEl = $<HTMLInputElement>("search");
  const clearBtn = $<HTMLButtonElement>("clear-btn");
  const listEl = $("list");
  const emptyEl = $("empty");
  const emptyTitle = $("empty-title");
  const emptyText = $("empty-text");

  const SEARCH_DEBOUNCE_MS = 120;
  const MONTH_FORMAT = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const MONTH_YEAR_FORMAT = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  let entries: Entry[] = [];
  let query = "";
  /** True once the store is known to hold something (an empty-query answer, or any match). Enables "Clear history…". */
  let hasAny = false;
  /** Bumped per request: an answer for an older request is dropped. */
  let seq = 0;
  let searchTimer: number | undefined;
  /** The url whose row takes focus after the next render (set when the focused row is removed). */
  let focusAfter: string | null | undefined;

  // ---- small DOM helpers ----

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Pen-set icons (glyphs.ts, loaded first). Static ones in history.html are data-pen-slot spans.
  function icon(name: string, cls = ""): SVGSVGElement {
    return penIcon(name, cls ? "icon " + cls : "icon");
  }
  penMountSlots();

  // ---- formatting ----

  const pad2 = (n: number): string => (n < 10 ? "0" + n : String(n));
  const timeLabel = (ms: number): string => {
    const d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  };
  const dayStart = (ms: number): number => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  function dayLabel(ms: number, now: number): string {
    const days = Math.round((dayStart(now) - dayStart(ms)) / 86400000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
    return (sameYear ? MONTH_FORMAT : MONTH_YEAR_FORMAT).format(ms);
  }
  /** Host + path without scheme, a leading www. and a trailing slash. */
  function shortUrl(url: string): string {
    try {
      const u = new URL(url);
      return (u.host.replace(/^www\./, "") + u.pathname + u.search).replace(/\/$/, "");
    } catch {
      return url;
    }
  }
  const hostOf = (url: string): string => {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch {
      return url;
    }
  };

  // ---- render ----

  function rowButtons(): HTMLButtonElement[] {
    return Array.from(listEl.querySelectorAll<HTMLButtonElement>(".row-main"));
  }
  function focusRow(url: string | null): boolean {
    if (url === null) return false;
    const row = rowButtons().find((b) => b.dataset.url === url);
    row?.focus();
    return row !== undefined;
  }

  function buildRow(entry: Entry): HTMLElement {
    const row = el("div", "row");
    row.setAttribute("role", "listitem");
    const main = el("button", "row-main");
    main.type = "button";
    main.dataset.url = entry.url;
    main.appendChild(el("span", "row-time", timeLabel(entry.lastVisitedAt)));
    main.appendChild(icon("Globe", "row-glyph"));
    main.appendChild(el("span", "row-title", entry.title || hostOf(entry.url)));
    main.appendChild(el("span", "row-url", shortUrl(entry.url)));
    main.title = entry.url;
    main.addEventListener("click", () => void api.open(entry.url));
    row.appendChild(main);

    const remove = el("button", "row-remove");
    remove.type = "button";
    remove.tabIndex = -1; // Delete / Backspace on the row does the same from the keyboard
    remove.setAttribute("aria-label", "Remove from history");
    remove.title = "Remove from history";
    remove.appendChild(icon("X"));
    remove.addEventListener("click", () => removeEntry(entry.url, main));
    row.appendChild(remove);
    return row;
  }

  function render(): void {
    const active = document.activeElement;
    const keepFocus = focusAfter !== undefined ? focusAfter : active instanceof HTMLElement && listEl.contains(active) ? active.dataset.url ?? null : null;
    const refocus = focusAfter !== undefined || (active instanceof HTMLElement && listEl.contains(active));
    focusAfter = undefined;

    listEl.replaceChildren();
    const now = Date.now();
    let lastDay = -1;
    for (const entry of entries) {
      const day = dayStart(entry.lastVisitedAt);
      if (day !== lastDay) {
        lastDay = day;
        const label = el("div", "day", dayLabel(entry.lastVisitedAt, now));
        label.setAttribute("role", "presentation");
        listEl.appendChild(label);
      }
      listEl.appendChild(buildRow(entry));
    }

    const empty = entries.length === 0;
    listEl.hidden = empty;
    emptyEl.hidden = !empty;
    if (empty) {
      if (query.trim() === "") {
        emptyTitle.textContent = "No history yet";
        emptyText.textContent = "Pages you open in the browser appear here.";
      } else {
        emptyTitle.textContent = "No pages match “" + query.trim() + "”";
        emptyText.textContent = "";
      }
    }
    clearBtn.disabled = !hasAny;
    if (refocus && !focusRow(keepFocus)) {
      // The focused row is gone (removed or filtered out): leave focus on the search field, not on <body>.
      if (document.activeElement === document.body) searchEl.focus();
    }
  }

  async function refresh(): Promise<void> {
    const mine = ++seq;
    const asked = query;
    let result: ListResult;
    try {
      result = await api.list(asked);
    } catch {
      return;
    }
    if (mine !== seq || !("entries" in result)) return; // a newer request is in flight, or this page is not answered
    entries = result.entries;
    if (asked.trim() === "") hasAny = entries.length > 0;
    else if (entries.length > 0) hasAny = true;
    render();
  }

  async function removeEntry(url: string, from: HTMLElement): Promise<void> {
    const rows = rowButtons();
    const i = rows.indexOf(from as HTMLButtonElement);
    const neighbour = rows[i + 1] ?? rows[i - 1];
    if (document.activeElement === from || listEl.contains(document.activeElement)) focusAfter = neighbour?.dataset.url ?? null;
    await api.remove(url);
    await refresh();
  }

  // ---- events ----

  api.onChanged(() => void refresh());

  searchEl.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = searchEl.value;
      void refresh();
    }, SEARCH_DEBOUNCE_MS);
  });
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      rowButtons()[0]?.focus();
    } else if (e.key === "Escape" && searchEl.value !== "") {
      e.preventDefault();
      searchEl.value = "";
      window.clearTimeout(searchTimer);
      query = "";
      void refresh();
    }
  });

  clearBtn.addEventListener("click", async () => {
    clearBtn.disabled = true;
    try {
      await api.clear(); // main asks for confirmation; the change event refreshes the list
    } finally {
      await refresh();
    }
  });

  listEl.addEventListener("keydown", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLButtonElement) || !target.classList.contains("row-main")) return;
    const rows = rowButtons();
    const i = rows.indexOf(target);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      rows[Math.min(i + 1, rows.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (i === 0) searchEl.focus();
      else rows[i - 1]?.focus();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (target.dataset.url) void removeEntry(target.dataset.url, target);
    }
    // Enter / Space click the button: the browser does that natively.
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
    }
  });

  void refresh();
})();
