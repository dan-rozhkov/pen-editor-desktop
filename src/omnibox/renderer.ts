// Address-bar suggestion popover page (its own transparent WebContentsView, see layout.ts
// omniboxBounds). Plain script (no exports), like the other renderers; wrapped in a function so no
// name leaks into the global scope shared with glyphs.js / relativeTime.js. The tab bar owns the
// query, the items, the selection and every key: this page only paints and reports clicks through
// the minimal `penOmnibox` bridge (preload/omnibox.ts).
(function () {
  type Item = { url: string; title: string; lastVisitedAt: number };
  const bridge = (window as unknown as {
    penOmnibox: {
      onRender(cb: (p: { items: Item[]; selected: number; query: string; theme: "light" | "dark"; isMac: boolean }) => void): void;
      pick(url: string): void;
      remove(url: string): void;
      openHistory(): void;
    };
  }).penOmnibox;
  const card = document.getElementById("card")!;

  /** Host + path without the scheme and a leading "www."; the bare root path is dropped. */
  function displayUrl(raw: string): string {
    try {
      const u = new URL(raw);
      const path = u.pathname === "/" ? "" : u.pathname;
      return u.host.replace(/^www\./, "") + path + u.search;
    } catch {
      return raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").replace(/^www\./, "");
    }
  }

  /** The title as text and <b> runs: every case-insensitive occurrence of a query token is bold. */
  function appendHighlighted(parent: HTMLElement, text: string, query: string): void {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const lower = text.toLowerCase();
    const bold: boolean[] = new Array(text.length).fill(false);
    for (const token of tokens) {
      for (let at = lower.indexOf(token); at !== -1; at = lower.indexOf(token, at + token.length)) {
        for (let i = at; i < at + token.length; i++) bold[i] = true;
      }
    }
    let start = 0;
    for (let i = 1; i <= text.length; i++) {
      if (i < text.length && bold[i] === bold[start]) continue;
      const run = text.slice(start, i);
      if (bold[start]) {
        const b = document.createElement("b");
        b.textContent = run;
        parent.appendChild(b);
      } else {
        parent.appendChild(document.createTextNode(run));
      }
      start = i;
    }
  }

  function globe(): SVGSVGElement {
    return penIcon("Globe", "glyph");
  }

  function div(cls: string, text?: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  // Picks fire on mousedown with the default prevented, so the address field keeps its focus until the pick lands.
  function onPrimaryMouseDown(el: HTMLElement, fn: () => void): void {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (e.button === 0) fn();
    });
  }

  function itemRow(item: Item, selected: boolean, query: string, now: number): HTMLElement {
    const row = div("row" + (selected ? " selected" : ""));
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(selected));
    row.appendChild(globe());
    const title = div("title");
    appendHighlighted(title, item.title || displayUrl(item.url), query);
    row.appendChild(title);
    row.appendChild(div("url", displayUrl(item.url)));
    const trail = div("trail");
    trail.appendChild(div("time", formatRelativeTime(item.lastVisitedAt, now)));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.setAttribute("aria-label", "Remove from history");
    remove.textContent = "×";
    onPrimaryMouseDown(remove, () => bridge.remove(item.url));
    trail.appendChild(remove);
    row.appendChild(trail);
    // The × sits inside the row: its mousedown must not also pick the row.
    onPrimaryMouseDown(row, () => bridge.pick(item.url));
    remove.addEventListener("mousedown", (e) => e.stopPropagation());
    return row;
  }

  bridge.onRender(({ items, selected, query, theme, isMac }) => {
    document.documentElement.dataset.theme = theme;
    const now = Date.now();
    card.replaceChildren();
    if (query.trim() === "") card.appendChild(div("header", "Recent"));
    const rows = div("rows");
    items.forEach((item, i) => rows.appendChild(itemRow(item, i === selected, query, now)));
    card.appendChild(rows);
    card.appendChild(div("divider"));
    const footer = div("footer");
    footer.appendChild(div("label", "Show all history"));
    footer.appendChild(div("hint", isMac ? "⌘Y" : "Ctrl+H"));
    onPrimaryMouseDown(footer, () => bridge.openHistory());
    card.appendChild(footer);
  });
})();
