/**
 * Canvas link router (agent layout): relays envelopes between the one agent
 * panel and the registered canvas tabs (editor tabs) of ONE window. Protocol:
 * docs/canvas-link.md (types in pen-editor `src/lib/canvasLink/protocol.ts`).
 *
 * Pure and Electron-free like tabManager.ts: window.ts injects the sender
 * checks, the sends (so the channel literals stay greppable there) and the tab
 * actions, and owns the ipcMain listeners. Payloads are never interpreted:
 * only the envelope shape is checked, order is kept, nothing is batched.
 * A tab is identified by its webContents id (`tabId` on the wire).
 */

import { isRecord } from "./checkpointArgs";

export interface LinkEnvelope {
  id: string;
  sentAt: number;
  msg: { kind: string; [key: string]: unknown };
}

export interface CanvasTabInfo {
  tabId: number;
  registrationId: number;
  title: string;
  active: boolean;
}

/** An editor tab as TabManager knows it (strip order). */
export interface EditorTabInfo {
  webContentsId: number;
  title: string;
}

export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface CanvasLinkDeps {
  /** True only for editor tabs of this window. */
  isEditorTab(webContentsId: number): boolean;
  /** True only for this window's agent panel webContents. */
  isPanel(webContentsId: number): boolean;
  /** `webContents.send("canvas:from-tab", ...)` to the panel. */
  sendFromTab(msg: { tabId: number; env: LinkEnvelope }): void;
  /** `webContents.send("canvas:tabs", ...)` to the panel. */
  sendTabs(tabs: CanvasTabInfo[]): void;
  /** `webContents.send("canvas:from-panel", env)` to one tab. */
  sendFromPanel(webContentsId: number, env: LinkEnvelope): void;
  /** Opens a new editor tab (in the background unless `activate`); returns its webContents id. */
  openEditorTab(activate: boolean): number;
  /** Makes the editor tab with this webContents id the active tab. */
  activateTab(webContentsId: number): void;
  now(): number;
  timers?: TimerApi;
}

/** Kinds only main may produce; a renderer posting them is dropped. */
const MAIN_ONLY_KINDS = new Set(["error", "tab-gone", "panel-gone"]);

/** `canvas:open` resolves when the new tab registers, else rejects after this. */
export const OPEN_TIMEOUT_MS = 20_000;

export const ERR_NOT_ALLOWED = "Not allowed.";
export const ERR_OPEN_TIMEOUT = "The canvas tab did not register in time.";
export const ERR_OPEN_CLOSED = "The canvas tab was closed before it registered.";

function isEnvelope(value: unknown): value is LinkEnvelope {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.sentAt !== "number" || !Number.isFinite(value.sentAt)) return false;
  return isRecord(value.msg) && typeof value.msg.kind === "string";
}

interface Registered {
  registrationId: number;
  /** Order tiebreak for tabs that were never activated. */
  registeredSeq: number;
}

interface PendingOpen {
  resolve(v: { tabId: number; registrationId: number }): void;
  reject(e: Error): void;
  timer: unknown;
}

export class CanvasLinkRouter {
  private readonly registered = new Map<number, Registered>();
  /** Per tab, kept across re-registers so a reloaded tab gets a new id. */
  private readonly registrationCounter = new Map<number, number>();
  private readonly activationSeq = new Map<number, number>();
  private readonly pendingOpen = new Map<number, PendingOpen>();
  private titles = new Map<number, string>();
  private activeWc: number | null = null;
  private seq = 0;
  private nextMainId = 1;
  private lastPushed: string | null = "[]";
  private lastSyncKey = "";
  private readonly timers: TimerApi;

  constructor(private readonly deps: CanvasLinkDeps) {
    this.timers = deps.timers ?? {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  /** The registered canvas tabs, most recently active first. */
  listTabs(): CanvasTabInfo[] {
    return [...this.registered.entries()]
      .sort(([a, ra], [b, rb]) => {
        const sa = this.activationSeq.get(a) ?? 0;
        const sb = this.activationSeq.get(b) ?? 0;
        return sb - sa || rb.registeredSeq - ra.registeredSeq;
      })
      .map(([tabId, r]) => ({
        tabId,
        registrationId: r.registrationId,
        title: this.titles.get(tabId) ?? "Untitled",
        active: tabId === this.activeWc,
      }));
  }

  /**
   * TabManager state changed (title, activation, tab set). `activeWebContentsId`
   * is the active tab when it is an editor tab, else null (browser tab active:
   * the activation order is left as it was).
   */
  syncTabs(editorTabs: EditorTabInfo[], activeWebContentsId: number | null): void {
    // Cheap key compare: a state push that changed no tab, title or activation does nothing.
    const key = `${activeWebContentsId}|${editorTabs.map((t) => `${t.webContentsId}:${t.title}`).join("\u0000")}`;
    if (key === this.lastSyncKey) return;
    this.lastSyncKey = key;
    this.titles = new Map(editorTabs.map((t) => [t.webContentsId, t.title]));
    if (activeWebContentsId !== null && activeWebContentsId !== this.activeWc) {
      this.activationSeq.set(activeWebContentsId, ++this.seq);
    }
    this.activeWc = activeWebContentsId;
    // A registered id that is no longer an editor tab (a closing tab) is gone:
    // it must never be listed as "Untitled".
    const live = new Set(editorTabs.map((t) => t.webContentsId));
    for (const id of [...this.registered.keys()]) if (!live.has(id)) this.tabGone(id);
    this.pushTabs();
  }

  /** `canvas:register`. */
  register(sender: number): void {
    if (!this.deps.isEditorTab(sender)) return;
    const previous = this.registered.get(sender);
    if (previous) this.sendMainToPanel(sender, { kind: "tab-gone", registrationId: previous.registrationId });
    const registrationId = (this.registrationCounter.get(sender) ?? 0) + 1;
    this.registrationCounter.set(sender, registrationId);
    this.registered.set(sender, { registrationId, registeredSeq: ++this.seq });
    const pending = this.pendingOpen.get(sender);
    if (pending) {
      this.pendingOpen.delete(sender);
      this.timers.clear(pending.timer);
      pending.resolve({ tabId: sender, registrationId });
    }
    this.pushTabs();
  }

  /**
   * `canvas:unregister`: the registered tab says its canvas link is gone (its
   * page tore the link down without navigating). Same effect as `tabGone`.
   */
  unregister(sender: number): void {
    if (!this.deps.isEditorTab(sender)) return;
    this.tabGone(sender);
  }

  /** `canvas:to-panel`: tab -> panel, main adds the sender's tabId. */
  toPanel(sender: number, env: unknown): void {
    if (!this.deps.isEditorTab(sender) || !this.registered.has(sender)) return;
    if (!isEnvelope(env) || MAIN_ONLY_KINDS.has(env.msg.kind)) return;
    this.deps.sendFromTab({ tabId: sender, env });
  }

  /** `canvas:to-tab`: panel -> tab. An unregistered target answers `error` to the panel. */
  toTab(sender: number, payload: unknown): void {
    if (!this.deps.isPanel(sender)) return;
    if (typeof payload !== "object" || payload === null) return;
    const { tabId, env } = payload as { tabId?: unknown; env?: unknown };
    if (typeof tabId !== "number") return;
    if (!isEnvelope(env) || MAIN_ONLY_KINDS.has(env.msg.kind)) return;
    if (!this.registered.has(tabId) || !this.deps.isEditorTab(tabId)) {
      this.sendMainToPanel(tabId, { kind: "error", refId: env.id, error: `No canvas tab ${tabId} is registered.` });
      return;
    }
    this.deps.sendFromPanel(tabId, env);
  }

  /** `canvas:list` (invoke). */
  list(sender: number): CanvasTabInfo[] {
    if (!this.deps.isPanel(sender)) return [];
    const tabs = this.listTabs();
    this.lastPushed = JSON.stringify(tabs); // the panel now knows this list
    return tabs;
  }

  /** `canvas:activate`. Only a registered canvas tab can be activated. */
  activate(sender: number, tabId: unknown): void {
    if (!this.deps.isPanel(sender)) return;
    if (typeof tabId !== "number" || !this.registered.has(tabId)) return;
    this.deps.activateTab(tabId);
  }

  /** `canvas:open` (invoke): resolves `{tabId, registrationId}` once THAT tab registers (the registration that resolved it, so the panel can bind without waiting for the next `canvas:tabs`). */
  open(sender: number, opts: unknown): Promise<{ tabId: number; registrationId: number }> {
    if (!this.deps.isPanel(sender)) return Promise.reject(new Error(ERR_NOT_ALLOWED));
    const activate = typeof opts === "object" && opts !== null && (opts as { activate?: unknown }).activate === true;
    const tabId = this.deps.openEditorTab(activate);
    return new Promise((resolve, reject) => {
      const timer = this.timers.set(() => {
        this.pendingOpen.delete(tabId);
        reject(new Error(ERR_OPEN_TIMEOUT));
      }, OPEN_TIMEOUT_MS);
      this.pendingOpen.set(tabId, { resolve, reject, timer });
    });
  }

  /**
   * The tab was reloaded (a committed navigation) or (`destroyed`) closed. A
   * registered tab leaves the list and the panel gets `tab-gone`. A pending
   * `canvas:open` is rejected only on destroy: the tab's first navigation is
   * part of opening it.
   */
  tabGone(webContentsId: number, destroyed = false): void {
    this.drop(webContentsId, destroyed, destroyed);
  }

  /** The tab's renderer died: like `tabGone`, and a pending `canvas:open` for it can never register. */
  rendererGone(webContentsId: number): void {
    this.drop(webContentsId, true, false);
  }

  /**
   * The agent panel reloaded or its renderer died: every registered canvas tab
   * gets the main-made `panel-gone` (on `canvas:from-panel`) so it aborts
   * in-flight work, and the next `canvas:tabs` push is not deduped away (the
   * reloaded panel knows no list).
   */
  panelGone(): void {
    for (const id of this.registered.keys()) {
      this.deps.sendFromPanel(id, {
        id: `main-${this.nextMainId++}`,
        sentAt: this.deps.now(),
        msg: { kind: "panel-gone" },
      });
    }
    this.lastPushed = null;
  }

  /** Pushes the current list even if unchanged (the panel finished loading). */
  repush(): void {
    this.lastPushed = null;
    this.pushTabs();
  }

  private drop(webContentsId: number, rejectPending: boolean, forget: boolean): void {
    const reg = this.registered.get(webContentsId);
    if (reg) {
      this.registered.delete(webContentsId);
      this.sendMainToPanel(webContentsId, { kind: "tab-gone", registrationId: reg.registrationId });
    }
    if (rejectPending) {
      const pending = this.pendingOpen.get(webContentsId);
      if (pending) {
        this.pendingOpen.delete(webContentsId);
        this.timers.clear(pending.timer);
        pending.reject(new Error(ERR_OPEN_CLOSED));
      }
    }
    if (forget) {
      this.registrationCounter.delete(webContentsId);
      this.activationSeq.delete(webContentsId);
    }
    if (reg) this.pushTabs();
  }

  /** Window closed: drop everything without notifying (all views are going away). */
  dispose(): void {
    for (const p of this.pendingOpen.values()) {
      this.timers.clear(p.timer);
      p.reject(new Error(ERR_OPEN_CLOSED));
    }
    this.pendingOpen.clear();
    this.registered.clear();
  }

  private pushTabs(): void {
    const tabs = this.listTabs();
    const serialized = JSON.stringify(tabs);
    if (serialized === this.lastPushed) return;
    this.lastPushed = serialized;
    this.deps.sendTabs(tabs);
  }

  /** A main-made message about a tab, delivered to the panel as if from it. */
  private sendMainToPanel(tabId: number, msg: LinkEnvelope["msg"]): void {
    this.deps.sendFromTab({
      tabId,
      env: { id: `main-${this.nextMainId++}`, sentAt: this.deps.now(), msg },
    });
  }
}
