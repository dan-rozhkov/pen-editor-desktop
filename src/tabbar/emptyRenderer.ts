// Empty-state page of the tab area (agent layout, zero tabs). Plain script (no
// exports), like renderer.ts. Uses its own minimal preload bridge (`penEmpty`,
// preload/empty.ts); wrapped in a function so no name leaks into the global
// scope shared with renderer.ts.
(function () {
  const bridge = (window as unknown as {
    penEmpty: {
      newCanvasTab(): void;
      newBrowserTab(): void;
      newDocTab(): void;
      listRecent(): Promise<{ kind: "canvas" | "doc"; id: string; title: string; updatedAt: number }[]>;
      openItem(kind: "canvas" | "doc", id: string): void;
      openItemMenu(kind: "canvas" | "doc", id: string): void;
      onRecentChanged(cb: () => void): void;
      onState(cb: (state: { theme: "light" | "dark"; sessionTabs: number }) => void): void;
    };
  }).penEmpty;
  document.getElementById("new-canvas")!.addEventListener("click", () => bridge.newCanvasTab());
  document.getElementById("new-browser")!.addEventListener("click", () => bridge.newBrowserTab());
  document.getElementById("new-doc")!.addEventListener("click", () => bridge.newDocTab());
  const note = document.getElementById("sessions-note")!;
  // Fade-in + 4px rise whenever the placeholder appears: first load, and each time the view is
  // shown again (WebContentsView.setVisible fires visibilitychange). Without the `.shown` class the
  // content is in its start state (empty.css); toggling it off, forcing a reflow and on replays it.
  const content = document.getElementById("empty-state")!;
  const replay = () => {
    content.classList.remove("shown");
    void content.offsetWidth;
    content.classList.add("shown");
  };
  replay();
  // Replay only on "visible": `.shown` is never removed on "hidden", so a hidden event without a
  // matching visible one (platform-dependent) cannot leave the buttons at opacity 0.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") replay();
  });

  // ---- Recent list ----
  // Glyphs: glyphs.ts (plain script loaded before this one).
  const GLYPHS = { canvas: PHOSPHOR_PAINT_BRUSH, doc: PHOSPHOR_FILE_TEXT };
  const VISIBLE_ROWS = 8;
  const recent = document.getElementById("recent")!;
  const recentList = document.getElementById("recent-list")!;
  const recentMore = document.getElementById("recent-more") as HTMLButtonElement;
  let items: { kind: "canvas" | "doc"; id: string; title: string; updatedAt: number }[] = [];
  let expanded = false;

  const makeIcon = (kind: "canvas" | "doc") => {
    const ns = "http://www.w3.org/2000/svg";
    const svgEl = document.createElementNS(ns, "svg");
    svgEl.setAttribute("class", "recent-icon");
    svgEl.setAttribute("viewBox", "0 0 256 256");
    svgEl.setAttribute("aria-hidden", "true");
    const pathEl = document.createElementNS(ns, "path");
    pathEl.setAttribute("d", GLYPHS[kind]);
    svgEl.appendChild(pathEl);
    return svgEl;
  };
  const span = (cls: string, text: string) => {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  };

  const renderRecent = () => {
    recentList.textContent = "";
    recent.hidden = items.length === 0;
    // Compact cards in a small window (empty.css), so the list stays above the fold.
    content.classList.toggle("has-recent", items.length > 0);
    if (items.length === 0) return;
    const shown = expanded ? items : items.slice(0, VISIBLE_ROWS);
    const now = Date.now();
    for (const item of shown) {
      const li = document.createElement("li");
      const row = document.createElement("button");
      row.type = "button";
      row.className = "recent-row";
      row.appendChild(makeIcon(item.kind));
      row.appendChild(span("recent-title", item.title || "Untitled"));
      row.appendChild(span("recent-kind", item.kind === "canvas" ? "Canvas" : "Document"));
      row.appendChild(span("recent-time", formatRelativeTime(item.updatedAt, now)));
      row.addEventListener("click", () => bridge.openItem(item.kind, item.id));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        bridge.openItemMenu(item.kind, item.id);
      });
      li.appendChild(row);
      recentList.appendChild(li);
    }
    const hiddenCount = items.length - VISIBLE_ROWS;
    recentMore.hidden = expanded || hiddenCount <= 0;
    recentMore.textContent = "Show all (" + items.length + ")";
  };

  recentMore.addEventListener("click", () => {
    expanded = true;
    renderRecent();
    const rows = recentList.querySelectorAll<HTMLButtonElement>(".recent-row");
    rows[VISIBLE_ROWS]?.focus();
  });

  // ArrowUp / ArrowDown move focus between the rows.
  recentList.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(recentList.querySelectorAll<HTMLButtonElement>(".recent-row"));
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    const next = rows[at + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  });

  // A late, older answer must never overwrite a newer one.
  let refreshSeq = 0;
  const refreshRecent = () => {
    const seq = ++refreshSeq;
    bridge
      .listRecent()
      .then((list) => {
        if (seq !== refreshSeq) return;
        items = Array.isArray(list) ? list : [];
        renderRecent();
      })
      .catch(() => {});
  };
  refreshRecent();

  // Main reports stored changes (`empty:recent-changed`). Refetch (debounced) while visible; while hidden
  // do nothing: every "visible" refetches anyway.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  bridge.onRecentChanged(() => {
    if (document.visibilityState !== "visible") return;
    clearTimeout(debounce);
    debounce = setTimeout(refreshRecent, 250);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    clearTimeout(debounce);
    refreshRecent();
  });

  bridge.onState(({ theme, sessionTabs }) => {
    document.documentElement.dataset.theme = theme;
    note.hidden = !(sessionTabs > 0);
  });
})();
