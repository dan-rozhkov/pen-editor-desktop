// Client of the `sideform-computer-use` Swift helper: one long-lived child process,
// single-line JSON requests and responses over stdio (spec section 1). Electron-free:
// the process spawn is injected.

export interface ChildLike {
  stdin: { write(data: string): unknown; on?(event: "error", cb: (err: Error) => void): unknown };
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown };
  stderr?: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit", cb: (code: number | null, signal?: string | null) => void): unknown;
  /** A spawn failure (ENOENT, EACCES) arrives as an "error" event, never as a throw. */
  on(event: "error", cb: (err: Error) => void): unknown;
  /** Fired once the process started; an "error" after it is no spawn failure. */
  on(event: "spawn", cb: () => void): unknown;
  kill?(signal?: string): unknown;
}

export type SpawnHelper = (binPath: string) => ChildLike;

export interface HelperEvent {
  event: string;
  [key: string]: unknown;
}

/** A failed command: `code` is the helper's code (`STALE`, `NO_ACTION`, ...) or a client code. */
export class HelperError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "HelperError";
    this.code = code;
  }
}

/** Client codes: `TIMEOUT`, `HELPER_EXIT`, `HELPER_CLOSED`, `HELPER_SPAWN`. */
// Client timeout = the helper's own budget + 1 s, so the helper's error answer (a timeout code of its own)
// arrives before the client gives up. Helper budgets: snapshot/read/screenshot/perform 5 s, type 10 s, others 2 s.
export const SLOW_COMMANDS: ReadonlySet<string> = new Set(["snapshot", "read", "screenshot", "perform"]);
export const SLOW_TIMEOUT_MS = 6000;
export const TYPE_TIMEOUT_MS = 11000;
export const FAST_TIMEOUT_MS = 3000;

export interface HelperOptions {
  binPath: string;
  spawn: SpawnHelper;
  /** Per-command timeout overrides (ms), by command name. */
  timeouts?: Record<string, number>;
  /** Called with each stderr line (the helper's log). */
  onLog?: (line: string) => void;
}

export type HelperResult = Record<string, unknown>;

interface Pending {
  cmd: string;
  resolve(v: HelperResult): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class ComputerUseHelper {
  private child: ChildLike | null = null;
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private pending = new Map<number, Pending>();
  private eventListeners = new Set<(e: HelperEvent) => void>();
  private exitListeners = new Set<(code: number | null) => void>();

  constructor(private readonly opts: HelperOptions) {}

  /** Whether a helper process is currently running. */
  get alive(): boolean {
    return this.child !== null;
  }

  /** Unsolicited events (`appTerminated`). Returns an unsubscribe function. */
  onEvent(cb: (e: HelperEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /** The helper process exited (not on `close()`). Returns an unsubscribe function. */
  onExit(cb: (code: number | null) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  timeoutFor(cmd: string, override?: number): number {
    if (override !== undefined) return override;
    const configured = this.opts.timeouts?.[cmd];
    if (configured !== undefined) return configured;
    if (cmd === "type") return TYPE_TIMEOUT_MS;
    return SLOW_COMMANDS.has(cmd) ? SLOW_TIMEOUT_MS : FAST_TIMEOUT_MS;
  }

  /**
   * Run one command. Resolves with the response fields (without `id` and `ok`).
   * Rejects with `HelperError`. The process starts on the first call and starts
   * again on the first call after it died.
   */
  call(cmd: string, args: Record<string, unknown> = {}, callOpts: { timeoutMs?: number } = {}): Promise<HelperResult> {
    if (this.closed) return Promise.reject(new HelperError("The computer use helper is closed.", "HELPER_CLOSED"));
    let child: ChildLike;
    try {
      child = this.ensureChild();
    } catch (e) {
      return Promise.reject(new HelperError(`The computer use helper did not start: ${(e as Error).message}`, "HELPER_SPAWN"));
    }
    const id = this.nextId++;
    const timeoutMs = this.timeoutFor(cmd, callOpts.timeoutMs);
    return new Promise<HelperResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError(`The computer use helper did not answer "${cmd}" within ${timeoutMs} ms.`, "TIMEOUT"));
      }, timeoutMs);
      this.pending.set(id, { cmd, resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ ...args, id, cmd })}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HelperError(`The computer use helper could not be written to: ${(e as Error).message}`, "HELPER_EXIT"));
      }
    });
  }

  /** Stop the helper. Pending calls reject; later calls reject too. */
  close(): void {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.buffer = "";
    this.rejectAll(new HelperError("The computer use helper is closed.", "HELPER_CLOSED"));
    try {
      child?.kill?.();
    } catch {
      /* already gone */
    }
  }

  private ensureChild(): ChildLike {
    if (this.child) return this.child;
    const child = this.opts.spawn(this.opts.binPath);
    this.child = child;
    this.buffer = "";
    let started = false;
    child.stdout.on("data", (chunk) => {
      started = true;
      if (this.child === child) this.onData(chunk.toString());
    });
    child.stderr?.on("data", (chunk) => {
      const log = this.opts.onLog;
      if (!log) return;
      for (const line of chunk.toString().split("\n")) if (line.trim() !== "") log(line);
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.buffer = "";
      this.rejectAll(new HelperError(`The computer use helper exited (code ${code ?? "none"}).`, "HELPER_EXIT"));
      for (const cb of [...this.exitListeners]) cb(code);
    });
    // Without these listeners an ENOENT/EACCES at spawn or an EPIPE on stdin would be an uncaught exception in main.
    child.on("spawn", () => {
      started = true;
    });
    child.on("error", (err) => {
      if (this.child !== child) return;
      this.child = null;
      this.buffer = "";
      this.rejectAll(
        started
          ? new HelperError(`The computer use helper failed: ${err.message}`, "HELPER_EXIT")
          : new HelperError(`The computer use helper did not start: ${err.message}`, "HELPER_SPAWN"),
      );
      try {
        child.kill?.();
      } catch {
        /* already gone */
      }
      for (const cb of [...this.exitListeners]) cb(null);
    });
    child.stdin.on?.("error", (err) => {
      if (this.child !== child) return;
      this.child = null;
      this.buffer = "";
      this.rejectAll(new HelperError(`The computer use helper could not be written to: ${err.message}`, "HELPER_EXIT"));
      try {
        child.kill?.();
      } catch {
        /* already gone */
      }
      for (const cb of [...this.exitListeners]) cb(null);
    });
    return child;
  }

  private onData(text: string): void {
    this.buffer += text;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line !== "") this.onLine(line);
      nl = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      this.opts.onLog?.(`unparsable helper line: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof msg.id !== "number") {
      if (typeof msg.event === "string") for (const cb of [...this.eventListeners]) cb(msg as HelperEvent);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return; // answered after its timeout
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok === true) {
      const { id: _id, ok: _ok, ...rest } = msg;
      void _id;
      void _ok;
      p.resolve(rest);
    } else {
      const err = typeof msg.error === "string" ? msg.error : `The helper failed "${p.cmd}".`;
      p.reject(new HelperError(err, typeof msg.code === "string" ? msg.code : undefined));
    }
  }

  private rejectAll(err: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }
}
