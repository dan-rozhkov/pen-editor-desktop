import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, app, net, session } from "electron";
import { MIGRATE_PAGE_HTML, ORIGIN_MIGRATION_FILE, migrateIfNeeded, migrateUrl, type MigrationPort } from "./originMigration";
import { LEGACY_EDITOR_ORIGIN, isEnvValueSet } from "./config";
import { secureWebPreferences } from "./webPreferences";

/** Electron glue for originMigration.ts: a hidden window on the DEFAULT session
 * (the one the editor tabs use), so it sees the same per-origin storage. */
function createHiddenWindowPort(): MigrationPort {
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: secureWebPreferences() });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return {
    clearServiceWorkers: async (origins) => {
      // Only workers and Cache Storage: localStorage/IndexedDB are the data being migrated.
      for (const origin of origins) await session.defaultSession.clearStorageData({ origin, storages: ["serviceworkers", "cachestorage"] });
    },
    load: (url) => win.loadURL(url),
    currentUrl: () => win.webContents.getURL(),
    run: (script) => win.webContents.executeJavaScript(script, false),
    dispose: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

/** Answers exactly the two migration URLs with a tiny local page (no network: no redirect, no
 * offline failure) and passes everything else through. Returns the undo. */
function handleMigrationPages(origins: string[]): () => void {
  const own = new Set(origins.map(migrateUrl));
  const protocol = session.defaultSession.protocol;
  protocol.handle("https", (request) => {
    if (own.has(request.url)) return new Response(MIGRATE_PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    return net.fetch(request, { bypassCustomProtocolHandlers: true });
  });
  return () => protocol.unhandle("https");
}

/** Called once before the main window is created. Never throws; the 5 s budget bounds everything. */
export async function runOriginMigrationOnStartup(editorUrl: string, env: NodeJS.ProcessEnv): Promise<void> {
  let undo: (() => void) | null = null;
  try {
    const from = LEGACY_EDITOR_ORIGIN;
    const to = new URL(editorUrl).origin;
    await migrateIfNeeded({
      overridden: isEnvValueSet(env.PEN_DESKTOP_URL),
      from,
      to,
      flagPath: path.join(app.getPath("userData"), ORIGIN_MIGRATION_FILE),
      fs: {
        read: (p) => {
          try {
            return fs.readFileSync(p, "utf8");
          } catch {
            return null;
          }
        },
        write: (p, text) => fs.writeFileSync(p, text, "utf8"),
      },
      makePort: () => {
        // Registered only when a migration really runs, and undone in the finally below.
        undo = handleMigrationPages([from, to]);
        return createHiddenWindowPort();
      },
      now: () => new Date(),
      log: (m) => console.log(`[migration] ${m}`),
    });
  } catch (err) {
    console.error("[migration] unexpected error; continuing startup:", err);
  } finally {
    try {
      (undo as (() => void) | null)?.();
    } catch (err) {
      console.error("[migration] could not remove the https handler:", err);
    }
  }
}
