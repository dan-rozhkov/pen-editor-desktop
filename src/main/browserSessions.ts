// Isolated browser sessions (docs/superpowers/specs/2026-10-17-isolated-parallel-browse-design.md).
//
// A session is a private browser: a partition taken from an app-wide pool, its
// own BrowserController (snapshot ids, cursor, fixture, journal) and its own
// network-mock router. This module holds every decision: id validation, which
// commands may create a session and what a missing/closed one answers, the
// partition pool, the registry (ownership, in-flight commands, tombstones,
// orphans) and per-scope counters. Electron-free and generic over the
// per-session context `C` (window.ts fills it), so it is unit-tested.
import { BROWSER_COMMANDS } from "./browserCommands";
import { ERR_NO_JOURNAL } from "./journalOwners";

/** `sessionId`: 1 to 64 characters of letters, digits, `_` and `-`. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** App-wide number of partition slots (= live sessions across all windows). */
export const PARTITION_POOL_SIZE = 6;
/** How long a command waits for a free slot before giving up. */
export const SLOT_WAIT_MS = 60_000;
/** How long closeSession waits for the session's in-flight commands. */
export const DRAIN_TIMEOUT_MS = 30_000;
/**
 * Closed ids remembered so they can never be recreated. Tombstones belong to the
 * editor tab that owned the session and are dropped when that tab is destroyed
 * (`forgetOwner`); a reload keeps them. The cap bounds a very long-lived tab:
 * past it the OLDEST id is forgotten (a run id is unique per run, so reuse of an
 * evicted id needs 10 000 newer closes first).
 */
export const TOMBSTONE_LIMIT = 10_000;

export const ERR_INVALID_SESSION_ID = "invalid session id";
export const ERR_TOO_MANY_SESSIONS = "too many parallel browser sessions";
export const ERR_SESSION_NOT_OWNED = "browser session belongs to another editor tab";
export const ERR_SESSION_CLOSED = "browser session closed";
export const ERR_NO_SUCH_SESSION = "no such browser session";
export const ERR_SESSION_CREATE_FAILED = "could not create browser session";
/** Fixed text: a saved login must never be typed into an isolated session. */
export const ERR_LOGINS_UNAVAILABLE = "saved logins are not available in an isolated session";

/**
 * Thrown by a session factory when its pool slot cannot be made safe (e.g. the
 * deny-all permission policy failed). The slot is quarantined, not returned.
 */
export class SlotUnusableError extends Error {}

export type ParsedSession = { ok: true; id: string | undefined } | { ok: false; error: string };

/**
 * The optional `session` field of a `browser:command` payload. A payload
 * without the key is the shared browser. A payload WITH the key must carry a
 * valid id string: `session: undefined` or `null` (a caller that lost its id)
 * is an error, never a silent fallback to the shared browser.
 */
export function parseSessionId(payload: Record<string, unknown>): ParsedSession {
  if (!Object.hasOwn(payload, "session")) return { ok: true, id: undefined };
  const value = payload.session;
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) return { ok: false, error: ERR_INVALID_SESSION_ID };
  return { ok: true, id: value };
}

// ---------------------------------------------------------------- commands

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(BROWSER_COMMANDS);

/** Only commands that bring a page into being may create a session. */
export function commandMayCreateSession(command: string, args: unknown): boolean {
  if (command === "open" || command === "applyFixture" || command === "startJournal") return true;
  if (command === "tabs") {
    return typeof args === "object" && args !== null && (args as { action?: unknown }).action === "new";
  }
  return false;
}

/** The natural answer of a cleanup command for a session that is gone. */
function cleanupAnswer(command: string): unknown {
  if (command === "releaseFixture") return { ok: true };
  if (command === "stopJournal") return false;
  if (command === "captureCheckpoint") return { ok: false, error: ERR_NO_JOURNAL };
  return undefined;
}

export type SessionState = "live" | "pending" | "missing" | "closed" | "foreign";

export type SessionPlan = { action: "reply"; value: unknown } | { action: "run"; create: boolean };

/**
 * What to do with one command addressed to a session, decided BEFORE anything
 * is created. `state` is the registry's view for this sender.
 */
export function planSessionCommand(command: string, args: unknown, state: SessionState): SessionPlan {
  if (!KNOWN_COMMANDS.has(command)) return { action: "reply", value: { error: `Unknown browser command: ${command}` } };
  if (state === "foreign") return { action: "reply", value: { error: ERR_SESSION_NOT_OWNED } };
  if (state === "missing" || state === "closed") {
    const cleanup = cleanupAnswer(command);
    if (cleanup !== undefined) return { action: "reply", value: cleanup };
    if (state === "closed") return { action: "reply", value: { error: ERR_SESSION_CLOSED } };
    if (commandMayCreateSession(command, args)) return { action: "run", create: true };
    return { action: "reply", value: { error: ERR_NO_SUCH_SESSION } };
  }
  // "live" and "pending" (being created): the command waits for the creation, then acts on it.
  if (command === "fillLogin") return { action: "reply", value: { ok: false, error: ERR_LOGINS_UNAVAILABLE } };
  return { action: "run", create: false };
}

// ---------------------------------------------------------------- timers

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

// ---------------------------------------------------------------- pool

/**
 * App-wide pool of in-memory partitions `qa-0` .. `qa-N`. A session takes a
 * free slot; the caller wipes the partition and only then returns it. A caller
 * with no free slot waits in FIFO order up to `waitMs`.
 */
export class PartitionPool {
  private readonly free: string[];
  private readonly waiters: { resolve: (slot: string | null) => void; timer: unknown }[] = [];
  private readonly used = new Set<string>();

  constructor(
    size: number = PARTITION_POOL_SIZE,
    private readonly waitMs: number = SLOT_WAIT_MS,
    private readonly timers: Timers = realTimers,
  ) {
    this.free = Array.from({ length: size }, (_, i) => `qa-${i}`);
  }

  acquire(): Promise<string | null> {
    return this.ticket().promise;
  }

  /** Like `acquire`, with a `cancel` that takes the waiter out of the queue (it then gets null). */
  ticket(): { promise: Promise<string | null>; cancel: () => void } {
    const slot = this.free.shift();
    if (slot !== undefined) return { promise: Promise.resolve(slot), cancel: () => {} };
    let cancel: () => void = () => {};
    const promise = new Promise<string | null>((resolve) => {
      const waiter = {
        resolve,
        timer: this.timers.set(() => {
          cancel();
        }, this.waitMs),
      };
      cancel = () => {
        const i = this.waiters.indexOf(waiter);
        if (i === -1) return;
        this.waiters.splice(i, 1);
        this.timers.clear(waiter.timer);
        resolve(null);
      };
      this.waiters.push(waiter);
    });
    return { promise, cancel };
  }

  /** The slot's partition is clean: the next waiter (if any) gets it. */
  release(slot: string): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      this.timers.clear(waiter.timer);
      waiter.resolve(slot);
    } else {
      this.free.push(slot);
    }
  }

  /** The slot already has its permission policy (set once per slot, app-wide). */
  isPrepared(slot: string): boolean {
    return this.used.has(slot);
  }

  /** Call only AFTER the policy was set successfully: a slot is never used without it. */
  markPrepared(slot: string): void {
    this.used.add(slot);
  }
}

// ---------------------------------------------------------------- registry

export interface BrowserSession<C> {
  id: string;
  /** webContents id of the editor tab that created the session. */
  owner: number;
  /** Pool slot `qa-0`..`qa-5` (shared by all sessions in turn). */
  partition: string;
  ctx: C;
  closing: boolean;
  /** Set while closing: a second close returns it. */
  closePromise?: Promise<void>;
  inFlight: number;
  drainWaiters: (() => void)[];
}

export type Entered<C> = { ok: true; session: BrowserSession<C>; exit: () => void } | { ok: false; error: string };

export class BrowserSessions<C> {
  private readonly sessions = new Map<string, BrowserSession<C>>();
  /** Creations in progress; `promise` resolves to an error text, or null when the session exists. */
  private readonly pending = new Map<
    string,
    { owner: number; cancelled: boolean; cancel: () => void; promise: Promise<string | null> }
  >();
  /** Closed (owner, id) pairs -> owner (insertion order = age). */
  private readonly tombstones = new Map<string, number>();

  constructor(
    private readonly pool: PartitionPool,
    private readonly timers: Timers = realTimers,
    private readonly onError: (what: string, err: unknown) => void = () => {},
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  /** Never reuse a closed id: ids are unique per run. */
  private tombstoneKey(id: string, owner: number): string {
    return `${owner}:${id}`;
  }

  private tombstone(id: string, owner: number): void {
    const key = this.tombstoneKey(id, owner);
    this.tombstones.delete(key);
    this.tombstones.set(key, owner);
    if (this.tombstones.size > TOMBSTONE_LIMIT) this.tombstones.delete(this.tombstones.keys().next().value as string);
  }

  /** The owner editor tab is gone for good: its tombstones can go. */
  forgetOwner(owner: number): void {
    for (const [id, o] of this.tombstones) if (o === owner) this.tombstones.delete(id);
  }

  stateOf(id: string, sender: number): SessionState {
    if (this.tombstones.has(this.tombstoneKey(id, sender))) return "closed";
    const s = this.sessions.get(id);
    if (!s) {
      const p = this.pending.get(id);
      if (!p) return "missing";
      return p.owner === sender ? "pending" : "foreign";
    }
    if (s.closing) return "closed";
    return s.owner === sender ? "live" : "foreign";
  }

  /** The session exists and is not closing (it may open tabs). */
  isLive(id: string): boolean {
    const s = this.sessions.get(id);
    return !!s && !s.closing;
  }

  /** The session by id whoever owns it (internal wiring only, never for a command). */
  peek(id: string): BrowserSession<C> | undefined {
    return this.sessions.get(id);
  }

  /** Owner of an existing or being-created session, for closeSession's ownership check. */
  ownerOf(id: string): number | undefined {
    return this.sessions.get(id)?.owner ?? this.pending.get(id)?.owner;
  }

  private enter(s: BrowserSession<C>): Entered<C> {
    s.inFlight++;
    let done = false;
    return {
      ok: true,
      session: s,
      exit: () => {
        if (done) return;
        done = true;
        s.inFlight--;
        if (s.inFlight === 0) for (const w of s.drainWaiters.splice(0)) w();
      },
    };
  }

  /**
   * Starts a command on the session (counted as in flight until `exit`).
   * With `allowCreate` a missing session is created: a slot is taken from the
   * pool (waiting FIFO, then ERR_TOO_MANY_SESSIONS). A command that finds the
   * session being created waits for it. A close racing the creation wins (the
   * slot goes back, ERR_SESSION_CLOSED); a throwing `create` releases the slot
   * and every waiter gets ERR_SESSION_CREATE_FAILED.
   */
  async acquire(id: string, sender: number, allowCreate: boolean, create: (partition: string) => C): Promise<Entered<C>> {
    for (;;) {
      const state = this.stateOf(id, sender);
      if (state === "closed") return { ok: false, error: ERR_SESSION_CLOSED };
      if (state === "foreign") return { ok: false, error: ERR_SESSION_NOT_OWNED };
      if (state === "live") return this.enter(this.sessions.get(id)!);
      const creating = this.pending.get(id);
      if (creating) {
        const failed = await creating.promise;
        if (failed) return { ok: false, error: failed };
        continue;
      }
      if (!allowCreate) return { ok: false, error: ERR_NO_SUCH_SESSION };
      const ticket = this.pool.ticket();
      const entry = { owner: sender, cancelled: false, cancel: ticket.cancel, promise: Promise.resolve<string | null>(null) };
      entry.promise = (async (): Promise<string | null> => {
        const slot = await ticket.promise;
        // closeSession arrived while we waited for a slot: the close wins.
        if (entry.cancelled || this.tombstones.has(this.tombstoneKey(id, sender))) {
          if (slot !== null) this.pool.release(slot);
          return ERR_SESSION_CLOSED;
        }
        if (slot === null) return ERR_TOO_MANY_SESSIONS;
        try {
          this.sessions.set(id, {
            id,
            owner: sender,
            partition: slot,
            ctx: create(slot),
            closing: false,
            inFlight: 0,
            drainWaiters: [],
          });
        } catch (err) {
          this.onError("create session", err);
          // An unusable slot (no permission policy) is never handed out again.
          if (err instanceof SlotUnusableError) this.onError("quarantined partition", slot);
          else this.pool.release(slot);
          return ERR_SESSION_CREATE_FAILED;
        }
        return null;
      })();
      this.pending.set(id, entry);
      let failed: string | null;
      try {
        failed = await entry.promise;
      } finally {
        this.pending.delete(id);
      }
      if (failed) return { ok: false, error: failed };
      const made = this.sessions.get(id);
      if (!made) return { ok: false, error: ERR_SESSION_CLOSED };
      return made.owner === sender ? this.enter(made) : { ok: false, error: ERR_SESSION_NOT_OWNED };
    }
  }

  /**
   * Start of a close. Ownership is checked first: a non-owner closes nothing and
   * tombstones nothing (the caller reports the error). Otherwise the (owner, id)
   * pair is tombstoned at once (no command can recreate or enter it) and a
   * creation still waiting for a slot is cancelled and leaves the pool queue.
   * Returns the live session to tear down, if any.
   */
  beginClose(id: string, owner: number): BrowserSession<C> | undefined {
    const existingOwner = this.ownerOf(id);
    if (existingOwner !== undefined && existingOwner !== owner) return undefined;
    this.tombstone(id, owner);
    const p = this.pending.get(id);
    if (p) {
      p.cancelled = true;
      p.cancel();
    }
    const s = this.sessions.get(id);
    if (!s || s.closing) return undefined;
    s.closing = true;
    return s;
  }

  /** Resolves true when the session has no command in flight, false after `timeoutMs`. */
  waitDrained(s: BrowserSession<C>, timeoutMs: number = DRAIN_TIMEOUT_MS): Promise<boolean> {
    if (s.inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = this.timers.set(() => resolve(false), timeoutMs);
      s.drainWaiters.push(() => {
        this.timers.clear(timer);
        resolve(true);
      });
    });
  }

  /**
   * The whole close (idempotent; a second call for a closing session returns the
   * SAME promise): tombstone, wait for in-flight commands, `abort` the session's
   * tabs if the wait timed out (that unblocks stuck commands), wait once more,
   * then `teardown` (fixture, tabs, wipe; true = partition is clean) and return
   * the slot. A slot is NEVER returned while an old command can still touch it
   * (still stuck after the second wait) nor when the wipe failed: the session is
   * dropped from the registry (controller and router freed), only the slot stays
   * quarantined for the rest of the app run.
   */
  close(
    id: string,
    owner: number,
    hooks: { abort: (s: BrowserSession<C>) => void; teardown: (s: BrowserSession<C>) => Promise<boolean> },
  ): Promise<void> {
    const existing = this.sessions.get(id);
    if (existing?.closing && existing.owner === owner && existing.closePromise) return existing.closePromise;
    const s = this.beginClose(id, owner);
    if (!s) return Promise.resolve();
    s.closePromise = (async () => {
      let drained = await this.waitDrained(s);
      if (!drained) {
        try {
          hooks.abort(s);
        } catch (err) {
          this.onError("abort session", err);
        }
        drained = await this.waitDrained(s);
      }
      if (!drained) return this.quarantine(s, "commands still in flight");
      let clean = false;
      try {
        clean = await hooks.teardown(s);
      } catch (err) {
        this.onError("close session", err);
      }
      if (clean) this.finishClose(s);
      else this.quarantine(s, "wipe failed");
    })();
    return s.closePromise;
  }

  /** Drops the session from the registry; its slot is NOT returned to the pool. */
  private quarantine(s: BrowserSession<C>, why: string): void {
    if (this.sessions.get(s.id) === s) this.sessions.delete(s.id);
    this.onError("quarantined partition", `${s.partition}: ${why}`);
  }

  /** The session is torn down and its partition wiped: free the slot. */
  finishClose(s: BrowserSession<C>): void {
    if (this.sessions.get(s.id) === s) this.sessions.delete(s.id);
    this.pool.release(s.partition);
  }

  /** Orphans: every live or being-created session owned by this editor tab. */
  idsOwnedBy(owner: number): string[] {
    const ids = [...this.sessions.values()].filter((s) => s.owner === owner && !s.closing).map((s) => s.id);
    for (const [id, p] of this.pending) if (p.owner === owner) ids.push(id);
    return ids;
  }
}

// ---------------------------------------------------------------- scopes

/** In-flight command counts per scope (undefined = shared browser, string = a session). */
export class ScopeCounter {
  private readonly counts = new Map<string, number>();
  private key(scope: string | undefined): string {
    return scope === undefined ? "" : `s:${scope}`;
  }
  inc(scope: string | undefined): void {
    this.counts.set(this.key(scope), (this.counts.get(this.key(scope)) ?? 0) + 1);
  }
  dec(scope: string | undefined): void {
    const next = (this.counts.get(this.key(scope)) ?? 0) - 1;
    if (next > 0) this.counts.set(this.key(scope), next);
    else this.counts.delete(this.key(scope));
  }
  active(scope: string | undefined): boolean {
    return (this.counts.get(this.key(scope)) ?? 0) > 0;
  }
}
