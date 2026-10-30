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
      listRecent(): Promise<{ kind: "canvas" | "doc" | "workflow"; id: string; title: string; updatedAt: number }[]>;
      openItem(kind: "canvas" | "doc" | "workflow", id: string): void;
      openItemMenu(kind: "canvas" | "doc" | "workflow", id: string): void;
      deleteItems(items: { kind: "canvas" | "doc" | "workflow"; id: string }[]): Promise<{
        ok: boolean;
        deleted?: number;
        failed?: { kind: "canvas" | "doc" | "workflow"; id: string }[];
        cancelled?: boolean;
      }>;
      openFilterMenu(
        anchor: { x: number; y: number },
        state: { kinds: { canvas: boolean; doc: boolean; workflow: boolean }; modified: RecentModifiedRange },
      ): Promise<
        { action: "kind"; kind: "canvas" | "doc" | "workflow"; checked: boolean } | { action: "modified"; modified: RecentModifiedRange } | { action: "reset" } | null
      >;
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
  // Glyphs: glyphs.ts, filter: recentFilter.ts (plain scripts loaded before this one).
  type Kind = "canvas" | "doc" | "workflow";
  type Item = { kind: Kind; id: string; title: string; updatedAt: number };
  const GLYPHS = { canvas: "PaintBrush", doc: "FileText", workflow: "ListBullets" };
  const KIND_LABELS = { canvas: "Canvas", doc: "Document", workflow: "Workflow" };
  const VISIBLE_ROWS = 8;
  const recent = document.getElementById("recent")!;
  const recentList = document.getElementById("recent-list")!;
  const recentMore = document.getElementById("recent-more") as HTMLButtonElement;
  const bar = document.getElementById("recent-bar")!;
  const selbar = document.getElementById("recent-selbar")!;
  const searchToggle = document.getElementById("recent-search-toggle") as HTMLButtonElement;
  const searchWrap = document.getElementById("recent-search-wrap")!;
  const searchInput = document.getElementById("recent-search") as HTMLInputElement;
  const searchClear = document.getElementById("recent-search-clear") as HTMLButtonElement;
  const filterToggle = document.getElementById("recent-filter-toggle") as HTMLButtonElement;
  const countLabel = document.getElementById("recent-count")!;
  const noteLabel = document.getElementById("recent-note")!;
  const selectAllBtn = document.getElementById("recent-select-all") as HTMLButtonElement;
  const deleteBtn = document.getElementById("recent-delete") as HTMLButtonElement;
  const emptyResult = document.getElementById("recent-empty")!;
  penMountSlots();

  let items: Item[] = [];
  let expanded = false;
  let kinds = { canvas: true, doc: true, workflow: true };
  let modified: RecentModifiedRange = "any";
  // Selection is keyed "kind:id". `rows` maps the rendered keys to their elements, so a toggle updates in place
  // (no rebuild: the focused checkbox keeps focus). `lastToggled` anchors Shift+click ranges.
  const selected = new Set<string>();
  const rows = new Map<string, { li: HTMLElement; check: HTMLInputElement; button: HTMLButtonElement }>();
  let shownKeys: string[] = [];
  let lastToggled: string | null = null;
  let deleting = false;

  const keyOf = (item: { kind: Kind; id: string }) => item.kind + ":" + item.id;
  const makeIcon = (kind: Kind) => penIcon(GLYPHS[kind], "recent-icon");
  const span = (cls: string, text: string) => {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  };
  const filterState = (): RecentFilterState => ({ query: searchInput.value, kinds, modified });
  const filterIsDefault = () => kinds.canvas && kinds.doc && kinds.workflow && modified === "any";
  const filtering = () => searchInput.value.trim() !== "" || !filterIsDefault();
  // Inline note of the selection bar ("Couldn't delete 2 items."). Any selection change clears it.
  const setNote = (text: string) => {
    noteLabel.textContent = text;
  };
  const matches = () => filterRecentItems(items, filterState(), Date.now());

  // Header: selection mode swaps the bar for the selection bar; rows show their checkboxes.
  const syncSelection = () => {
    const n = selected.size;
    const matching = matches();
    recent.classList.toggle("selecting", n > 0);
    bar.hidden = n > 0;
    selbar.hidden = n === 0;
    countLabel.textContent = n + " selected";
    selectAllBtn.hidden = matching.length > 0 && matching.every((item) => selected.has(keyOf(item)));
    deleteBtn.disabled = deleting;
    for (const [key, row] of rows) {
      const on = selected.has(key);
      row.li.classList.toggle("selected", on);
      row.check.checked = on;
    }
  };
  const clearSelection = () => {
    setNote("");
    selected.clear();
    lastToggled = null;
    syncSelection();
  };
  const setSelected = (key: string, on: boolean) => {
    if (on) selected.add(key);
    else selected.delete(key);
  };
  const toggleKey = (key: string, range: boolean, forceOn?: boolean) => {
    setNote("");
    const on = forceOn ?? !selected.has(key);
    const from = range && lastToggled !== null ? shownKeys.indexOf(lastToggled) : -1;
    const to = shownKeys.indexOf(key);
    if (from !== -1 && to !== -1) {
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) setSelected(shownKeys[i], on);
    } else setSelected(key, on);
    lastToggled = key;
    syncSelection();
  };

  // While a search or filter is on, the list block (rows + "no matches" + "Show all") keeps the height it had in
  // the default view: the page content is vertically centred, so a shrinking block would make the whole page jump.
  // `baseHeight` is re-measured on every default render; CSSOM is allowed under the CSP, style attributes are not.
  const recentBody = document.getElementById("recent-body")!;
  let baseHeight = 0;
  const updateHeightLock = () => {
    if (filtering() || !searchWrap.hidden) {
      recentBody.style.minHeight = baseHeight + "px";
    } else {
      recentBody.style.minHeight = "";
      baseHeight = recentBody.offsetHeight;
    }
  };

  const renderRecent = () => {
    // A background refresh rebuilds the rows: remember which control of which row had focus and give it back.
    let focusKey: string | null = null;
    let focusCheck = false;
    const active = document.activeElement;
    if (active && recentList.contains(active)) {
      for (const [key, row] of rows) {
        if (row.check === active || row.button === active) {
          focusKey = key;
          focusCheck = row.check === active;
        }
      }
    }
    recentList.textContent = "";
    rows.clear();
    // The section stays while the store has items, even if the filter hides them all.
    recent.hidden = items.length === 0;
    // Compact cards in a small window (empty.css), so the list stays above the fold.
    content.classList.toggle("has-recent", items.length > 0);
    if (items.length === 0) {
      shownKeys = [];
      recentMore.hidden = true;
      emptyResult.hidden = true;
      clearSelection();
      updateHeightLock();
      return;
    }
    const found = matches();
    // While a search or filter is on, every match is listed (no 8-row cap).
    const shown = expanded || filtering() ? found : found.slice(0, VISIBLE_ROWS);
    shownKeys = shown.map(keyOf);
    const now = Date.now();
    for (const item of shown) {
      const key = keyOf(item);
      const li = document.createElement("li");
      li.className = "recent-item";
      const title = item.title || "Untitled";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "recent-check";
      check.setAttribute("aria-label", "Select " + title);
      check.addEventListener("click", (e) => toggleKey(key, e.shiftKey, check.checked));
      const row = document.createElement("button");
      row.type = "button";
      row.className = "recent-row";
      row.appendChild(makeIcon(item.kind));
      row.appendChild(span("recent-title", title));
      row.appendChild(span("recent-kind", KIND_LABELS[item.kind]));
      row.appendChild(span("recent-time", formatRelativeTime(item.updatedAt, now)));
      row.addEventListener("click", (e) => {
        if (selected.size > 0 || e.metaKey || e.ctrlKey) toggleKey(key, e.shiftKey && selected.size > 0);
        else bridge.openItem(item.kind, item.id);
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        bridge.openItemMenu(item.kind, item.id);
      });
      li.appendChild(check);
      li.appendChild(row);
      recentList.appendChild(li);
      rows.set(key, { li, check, button: row });
    }
    emptyResult.hidden = found.length > 0;
    recentMore.hidden = expanded || filtering() || found.length - VISIBLE_ROWS <= 0;
    recentMore.textContent = "Show all (" + found.length + ")";
    syncSelection();
    updateHeightLock();
    const back = focusKey === null ? undefined : rows.get(focusKey);
    if (back) (focusCheck ? back.check : back.button).focus({ preventScroll: true });
  };

  recentMore.addEventListener("click", () => {
    expanded = true;
    renderRecent();
    const list = recentList.querySelectorAll<HTMLButtonElement>(".recent-row");
    list[VISIBLE_ROWS]?.focus();
  });

  // A changed search or filter starts a new result set: the selection does not carry over.
  const refilter = () => {
    setNote("");
    selected.clear();
    lastToggled = null;
    renderRecent();
    updateFilterUi();
  };

  // ---- Search ----
  const setSearchOpen = (open: boolean) => {
    searchWrap.hidden = !open;
    searchToggle.hidden = open;
    searchToggle.setAttribute("aria-expanded", String(open));
    if (open) searchInput.focus();
    updateHeightLock();
  };
  searchToggle.addEventListener("click", () => setSearchOpen(true));
  const syncSearchClear = () => {
    searchClear.hidden = searchInput.value === "";
  };
  searchInput.addEventListener("input", () => {
    syncSearchClear();
    refilter();
  });
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    syncSearchClear();
    refilter();
    searchInput.focus();
  });
  searchInput.addEventListener("blur", () => {
    if (searchInput.value === "") setSearchOpen(false);
  });

  // ---- Filter menu (native, like the other popups: main pops it under the button) ----
  function updateFilterUi() {
    filterToggle.classList.toggle("is-active", !filterIsDefault());
  }
  filterToggle.addEventListener("click", async () => {
    if (filterToggle.getAttribute("aria-expanded") === "true") return;
    // aria-expanded keeps the button in its pressed look while the menu is open.
    filterToggle.setAttribute("aria-expanded", "true");
    const rect = filterToggle.getBoundingClientRect();
    let choice: Awaited<ReturnType<typeof bridge.openFilterMenu>> = null;
    try {
      choice = await bridge.openFilterMenu({ x: rect.left, y: rect.bottom }, { kinds, modified });
    } catch (err) {
      console.error("filter menu failed", err);
    } finally {
      filterToggle.setAttribute("aria-expanded", "false");
      filterToggle.focus();
    }
    if (!choice) return;
    if (choice.action === "kind") kinds = { ...kinds, [choice.kind]: choice.checked };
    else if (choice.action === "modified") modified = choice.modified;
    else {
      kinds = { canvas: true, doc: true, workflow: true };
      modified = "any";
    }
    refilter();
  });

  document.getElementById("recent-clear-filters")!.addEventListener("click", () => {
    searchInput.value = "";
    syncSearchClear();
    setSearchOpen(false);
    kinds = { canvas: true, doc: true, workflow: true };
    modified = "any";
    refilter();
    filterToggle.focus();
  });

  // ---- Selection actions ----
  document.getElementById("recent-clear-selection")!.addEventListener("click", () => {
    clearSelection();
    filterToggle.focus();
  });
  selectAllBtn.addEventListener("click", () => {
    setNote("");
    // Every match, so list them all: nothing selected may hide behind "Show all".
    expanded = true;
    for (const item of matches()) selected.add(keyOf(item));
    renderRecent();
    deleteBtn.focus();
  });
  deleteBtn.addEventListener("click", () => {
    if (deleting || selected.size === 0) return;
    const chosen = items.filter((item) => selected.has(keyOf(item))).map((item) => ({ kind: item.kind, id: item.id }));
    deleting = true;
    syncSelection();
    bridge
      .deleteItems(chosen)
      .then((result) => {
        if (!result || result.cancelled) return; // cancelled: the selection stays so the user can retry
        if (!result.ok) {
          setNote("Couldn't delete these items.");
          return;
        }
        // Only the deleted keys leave the selection: toggles made while the delete ran stay, and so do the failed items.
        const failedKeys = new Set((result.failed ?? []).map(keyOf));
        for (const item of chosen) {
          const key = keyOf(item);
          if (failedKeys.has(key)) continue;
          selected.delete(key);
          if (lastToggled === key) lastToggled = null;
        }
        if (failedKeys.size > 0) setNote(failedKeys.size === 1 ? "Couldn't delete 1 item." : "Couldn't delete " + failedKeys.size + " items.");
        else setNote("");
        syncSelection(); // swaps the header back before focus moves into it
        if (selected.size === 0) filterToggle.focus();
      })
      .catch(() => {})
      .finally(() => {
        deleting = false;
        syncSelection();
        refreshRecent();
      });
  });

  // Esc: clear the search field (text first), else close it, else clear the selection.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (document.activeElement === searchInput) {
      if (searchInput.value !== "") {
        searchInput.value = "";
        syncSearchClear();
        refilter();
      } else {
        setSearchOpen(false);
        searchToggle.focus();
      }
    } else if (selected.size > 0) clearSelection();
  });

  // ArrowUp / ArrowDown move focus between the rows.
  recentList.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = Array.from(recentList.querySelectorAll<HTMLButtonElement>(".recent-row"));
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    const next = list[at + (e.key === "ArrowDown" ? 1 : -1)];
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
        // Drop selected ids that left the list.
        const live = new Set(items.map(keyOf));
        for (const key of Array.from(selected)) if (!live.has(key)) selected.delete(key);
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
