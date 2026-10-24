# Empty start: recent canvases and documents

## Intent

The user asked: on the empty start (agent layout, zero tabs) show the documents
and designs that the user or the agent made, as a list, like Notion and Linear do.
Goal: nothing the user or the agent made is lost, and it opens in one click.

Fact found first: canvases were not stored anywhere. Closing a canvas tab lost the
design. So the feature has two parts:

1. **Canvas storage** in the desktop shell, on the same principle as documents
   (the user confirmed: "холсты в десктопе надо сохранять по тому же принципу что и документы").
2. **A "Recent" list** on the empty start: canvases and documents, newest first.

Non-goals: the web build (it has no empty start and no disk), thumbnails, rename or
delete from the list, workflows (they live only in the frontend localStorage, which
the local empty page cannot read).

## Canvas storage (desktop)

- Directory `<userData>/canvases/` (`canvases-dev/` while `PEN_DESKTOP_URL` is set, as `docDirFor`).
- Per canvas two files: `<id>.meta.json` = `{id, title, updatedAt, rev}` and
  `<id>.pen.json` = `{id, rev, document}` where `document` is the `.pen` JSON string
  (`serializeDocument`). `list` reads meta files only, so it never parses big bodies.
  Write order: body first, then meta (tmp + rename, mode 0o600). A meta without a
  matching body (or a body rev below the meta rev) is skipped by `read`.
- Same rules as `docStore`: id `^[A-Za-z0-9_-]{1,64}$`, newer rev wins (stale save writes
  nothing and answers `{ok:true, stale:true, rev}`), per-id promise chain, in-memory rev
  cache, temp sweep, never pruned. Limits: title <= 10 000 chars, document <= 64 MB UTF-8.
- IPC (invoke, never throws): `canvases:list` -> `{canvases: CanvasMeta[]} | {error}`,
  `canvases:read(id)` -> `{canvas: StoredCanvas | null} | {error}`,
  `canvases:save(StoredCanvas)`, `canvases:delete(id)`. Senders: editor (canvas) tabs and the
  agent panel. Browser, doc, trace tabs are refused.
- Preload `tab.ts`: `penDesktop.canvases = { list, read, save, remove }`.

## Canvas identity (frontend)

- A desktop canvas tab URL carries `canvas=<id>`. When the editor mounts in the shell
  (`penDesktop.canvases` present, not `?view`, not the shared viewer) without that
  param, it generates `cv_<random>` and adds it with `history.replaceState` (as `/doc?new=1`
  becomes `?id=`). Every path that makes a canvas tab (button, Cmd+T, the agent) gets an id.
- With an id: read it from disk first. A stored canvas is applied with
  `applyOpenedDocument`. Autosave starts only after this read finishes, so an empty
  editor never overwrites a stored canvas.
- Autosave: debounced (~1 s) after scene/page changes, plus a flush on `pagehide`.
  A canvas that never had a node is not saved (blank tabs do not fill the list).
  `rev` +1 per save. Title: file name without extension, else the first top-level
  frame name, else "Untitled canvas".

## Recent list (desktop empty start)

Pattern from Linear/Notion lists: compact rows, a type icon, the title, quiet
metadata on the right, keyboard reachable.

- Below the three start cards: a section heading "Recent", then up to 8 rows,
  then "Show all (N)" when there are more. No section at all when nothing is stored.
- Row: 36 px high, Phosphor light icon 16 px (PaintBrush = canvas, FileText = document,
  the same glyphs as the tab bar), title (one line, ellipsis, "Untitled" fallback),
  a muted kind label, and a right-aligned relative time ("just now", "5 min ago",
  "3 h ago", "yesterday", "12 Oct") in tabular figures. Hover = `--btn-hover`, focus = the
  shared focus ring. Rows are buttons. ArrowUp/ArrowDown move focus between rows.
- Click: an open tab for that id is activated, else a new tab opens with focus.
- Data: `penEmpty.listRecent()` (invoke `empty:recent`): main merges `docs.list()` and
  `canvases.list()` into `{kind, id, title, updatedAt}`, newest first. The page asks
  again each time it becomes visible.
- `penEmpty.openCanvas(id)` / `penEmpty.openDoc(id)`: only the empty view may send them.
</content>
</invoke>
