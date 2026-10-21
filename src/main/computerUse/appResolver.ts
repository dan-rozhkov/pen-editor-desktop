// Resolves what the model asked for (a path or a name) to a RUNNING macOS app.
// Pure and Electron-free: the app list and the two lookups are injected.
import path from "node:path";

export interface RunningApp {
  pid: number;
  name: string;
  bundleId?: string;
  bundlePath?: string;
  executablePath?: string;
  active: boolean;
  hidden: boolean;
}

export interface ResolveDeps {
  /** fs.realpath; rejects when the path does not exist. */
  realpath(p: string): Promise<string>;
  /** Titles of the app's windows (any failure counts as none). */
  windowTitles(pid: number): Promise<string[]>;
  /** True for an app whose windows must never be listed (blocked or high risk): privacy of its titles. */
  skipTitleLookup?(app: RunningApp): boolean;
}

const norm = (s: string): string => s.trim().toLowerCase();
const byPreference = (a: RunningApp, b: RunningApp): number => Number(b.active) - Number(a.active) || a.pid - b.pid;

async function real(deps: ResolveDeps, p: string): Promise<string> {
  try {
    return await deps.realpath(p);
  } catch {
    return p;
  }
}

/**
 * A path (starts with "/" or "~", or ends with ".app") matches `bundlePath` by realpath, also a path inside the
 * bundle. A name matches `name` or the bundle file name without ".app", case-insensitive and trimmed. With no
 * name match, the exact (case-insensitive) title of any window matches; window titles are read only then, one app at a time, never for apps `skipTitleLookup` names.
 * Several matches: the frontmost first, then the lowest pid. A "~" path is matched as given (the caller expands it).
 */
export async function resolveRunningApp(requested: string, apps: readonly RunningApp[], deps: ResolveDeps): Promise<RunningApp | null> {
  const input = requested.trim();
  if (input === "" || input.includes("\0")) return null;
  const looksLikePath = input.startsWith("/") || input.startsWith("~") || input.toLowerCase().endsWith(".app");
  if (looksLikePath) {
    const want = await real(deps, input);
    const hits: RunningApp[] = [];
    for (const app of apps) {
      if (!app.bundlePath) continue;
      const bundle = await real(deps, app.bundlePath);
      if (want === bundle || want.startsWith(bundle.endsWith("/") ? bundle : `${bundle}/`)) hits.push(app);
    }
    if (hits.length > 0) return [...hits].sort(byPreference)[0];
    if (input.startsWith("/") || input.startsWith("~")) return null;
  }
  const wanted = norm(looksLikePath ? input.replace(/\.app$/i, "") : input);
  if (wanted === "") return null;
  const named = apps.filter((a) => norm(a.name) === wanted || (a.bundlePath !== undefined && norm(path.basename(a.bundlePath, ".app")) === wanted));
  if (named.length > 0) return [...named].sort(byPreference)[0];
  // Sequential with an early exit: the helper's AX queue is serial, so a parallel fan-out over every app
  // would make the later lookups time out. Skipped apps (password managers, messengers...) are never asked.
  for (const a of [...apps].sort(byPreference)) {
    if (deps.skipTitleLookup?.(a)) continue;
    const titles = await deps.windowTitles(a.pid).catch(() => [] as string[]);
    if (titles.some((t) => norm(t) === wanted)) return a;
  }
  return null;
}

/** Names of the running apps for an error text: frontmost first, then by name, unique, at most `max`. */
export function runningAppNames(apps: readonly RunningApp[], max = 15): string[] {
  const sorted = [...apps].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  return [...new Set(sorted.map((a) => a.name).filter((n) => n.trim() !== ""))].slice(0, max);
}
