/**
 * SPIKE (branch spike/ipc-streaming only, never merged to main): a router that
 * relays envelopes between two editor tabs of one window, a "chat" tab and a
 * "canvas" tab. Contract: docs/spike-ipc-streaming-contract.md.
 *
 * Pure and Electron-free like tabManager.ts: window.ts injects `isEditorTab`
 * (the sender check) and `deliver` (a `webContents.send("spike:deliver", ...)`
 * by webContents id), and owns the ipcMain listeners. One router per window.
 */

export type SpikeRole = "chat" | "canvas";

export interface SpikeEnvelope {
  id: string;
  /** performance.timeOrigin + performance.now() in the sending tab (epoch ms). */
  sentAt: number;
  msg: { kind: string; [key: string]: unknown };
}

export type SpikeDelivered = SpikeEnvelope & { relayedAt: number };

export interface SurfaceSpikeDeps {
  /** True only for editor tabs registered with this window. */
  isEditorTab(webContentsId: number): boolean;
  /** Sends one envelope to a tab. Must preserve call order per target. */
  deliver(webContentsId: number, delivered: SpikeDelivered): void;
  /** Epoch ms, performance.timeOrigin + performance.now(). Injected for tests. */
  now(): number;
}

/** Kinds only main may produce; a tab posting them is dropped. */
const MAIN_ONLY_KINDS = new Set(["error", "peer-gone"]);

const OTHER: Record<SpikeRole, SpikeRole> = { chat: "canvas", canvas: "chat" };

function isRole(value: unknown): value is SpikeRole {
  return value === "chat" || value === "canvas";
}

function isEnvelope(value: unknown): value is SpikeEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.sentAt !== "number" || !Number.isFinite(v.sentAt)) return false;
  const msg = v.msg as Record<string, unknown> | null;
  return typeof msg === "object" && msg !== null && typeof msg.kind === "string";
}

export class SurfaceSpikeRouter {
  private readonly holders: Record<SpikeRole, number | null> = { chat: null, canvas: null };
  private nextMainId = 1;

  constructor(private readonly deps: SurfaceSpikeDeps) {}

  /** The role a tab currently holds, or null. */
  roleOf(senderId: number): SpikeRole | null {
    if (this.holders.chat === senderId) return "chat";
    if (this.holders.canvas === senderId) return "canvas";
    return null;
  }

  /**
   * `spike:role`. null (or any invalid value from a valid sender) leaves the
   * spike. A new holder replaces the old one; the old holder's peer is told
   * `peer-gone` for the role it lost. Unregistered senders are ignored.
   */
  setRole(senderId: number, role: unknown): void {
    if (!this.deps.isEditorTab(senderId)) return;
    const next = isRole(role) ? role : null;
    const current = this.roleOf(senderId);
    if (current === next) return;
    if (current) this.release(senderId);
    if (!next) return;
    const displaced = this.holders[next];
    if (displaced !== null) this.release(displaced);
    this.holders[next] = senderId;
  }

  /**
   * `spike:post`. Forwards to the opposite role's holder, stamping relayedAt.
   * No peer (or sender without a role) answers `error` back to the sender.
   */
  post(senderId: number, env: unknown): void {
    if (!this.deps.isEditorTab(senderId)) return;
    if (!isEnvelope(env) || MAIN_ONLY_KINDS.has(env.msg.kind)) return;
    const role = this.roleOf(senderId);
    if (!role) {
      this.sendMain(senderId, { kind: "error", refId: env.id, error: "no role set" });
      return;
    }
    const peer = this.holders[OTHER[role]];
    if (peer === null || !this.deps.isEditorTab(peer)) {
      this.sendMain(senderId, { kind: "error", refId: env.id, error: `no ${OTHER[role]} tab` });
      return;
    }
    this.deps.deliver(peer, { id: env.id, sentAt: env.sentAt, msg: env.msg, relayedAt: this.deps.now() });
  }

  /** A tab was destroyed, reloaded or crashed: it leaves like setRole(null). */
  tabGone(webContentsId: number): void {
    if (this.roleOf(webContentsId)) this.release(webContentsId);
  }

  /** Window closed: drop every role without notifying (all tabs are going away). */
  dispose(): void {
    this.holders.chat = null;
    this.holders.canvas = null;
  }

  private release(id: number): void {
    const role = this.roleOf(id);
    if (!role) return;
    this.holders[role] = null;
    const peer = this.holders[OTHER[role]];
    if (peer !== null) this.sendMain(peer, { kind: "peer-gone", role });
  }

  private sendMain(target: number, msg: SpikeEnvelope["msg"]): void {
    const now = this.deps.now();
    this.deps.deliver(target, { id: `main-${this.nextMainId++}`, sentAt: now, msg, relayedAt: now });
  }
}
