// Pure decision + wait for "an MCP call arrived with no editor tab" (agent
// layout, zero tabs). No Electron import: unit-testable with fake timers.

/** Default time to wait for an on-demand tab to register its MCP bridge. */
export const ON_DEMAND_TAB_TIMEOUT_MS = 20_000;

export interface OnDemandTabInput {
  /** An opener is installed (agent layout only). */
  enabled: boolean;
  /** The call named a tab explicitly: never open one for it. */
  requestedTabId: number | undefined;
  /** The registry has an active editor tab right now. */
  hasActiveTab: boolean;
  /** An on-demand open is already running (concurrent calls share it). */
  inFlight: boolean;
}

/** True when the call must first open (or wait for) a canvas tab. */
export function needsOnDemandTab(input: OnDemandTabInput): boolean {
  if (!input.enabled || input.requestedTabId !== undefined) return false;
  return !input.hasActiveTab || input.inFlight;
}

export interface EnsureTabDeps {
  /** Opens a canvas tab in the background (no focus change). Called only when there is no active tab yet. */
  open(): void;
  hasActiveTab(): boolean;
  /** True once the active tab has registered its MCP bridge. */
  isReady(): boolean;
  /** Calls `cb` on every registration change; returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
  timeoutMs: number;
}

/** Opens a tab when none exists, then resolves true once it is ready, false after `timeoutMs`. */
export function ensureEditorTab(deps: EnsureTabDeps): Promise<boolean> {
  if (!deps.hasActiveTab()) deps.open();
  if (deps.isReady()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), deps.timeoutMs);
    const unsubscribe = deps.subscribe(() => {
      if (deps.isReady()) finish(true);
    });
  });
}
