import fs from "node:fs";
import path from "node:path";
import { app, BaseWindow, safeStorage, session } from "electron";
import { DISPLAY_APP_NAME, STORAGE_IDENTITY_FILE, resolveEditorUrl, resolveStorageIdentity, storageIdentityFileText } from "./config";
import { createMainWindow } from "./window";
import { appRegistry } from "./appTargetsService";
import { createMcpService } from "./mcp/service";
import { denyAllPermissions } from "./browser/permissions";
import { CREDENTIALS_FILE, createCredentialStore, nodeCredentialFs } from "./browser/credentialStore";
import { FAVICONS_FILE, createFaviconCache, createIconFetcher } from "./browser/faviconCache";
import { createLoginCapture } from "./browser/loginCapture";
import { createPasswordsWindow } from "./passwordsWindow";
import { shouldReopenMainWindow } from "./closeTarget";

const editorUrl = resolveEditorUrl(process.env);

// Storage identity (config.ts resolveStorageIdentity). The app was renamed from
// "Pineapple Editor" to "Sideform Desktop". An existing install keeps its
// legacy userData directory AND its legacy name here, BEFORE ready: Chromium
// takes the safeStorage Keychain item name ("<name> Safe Storage") from the
// name at ready and ignores later setName calls. A different name would make
// the saved-logins file undecryptable. The choice is persisted in the userData
// dir (storage-identity.json) so it stays sticky. The visible name is set
// after ready, below. e2e overrides the directory (PEN_DESKTOP_USER_DATA_DIR).
const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const storage = resolveStorageIdentity(
  process.env,
  app.getPath("appData"),
  {
    exists: fs.existsSync,
    isDirectory: isDir,
    read: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
  },
  path.join,
);
app.setName(storage.storageName);
app.setPath("userData", storage.userDataDir);
try {
  const idFile = path.join(storage.userDataDir, STORAGE_IDENTITY_FILE);
  if (!fs.existsSync(idFile)) {
    fs.mkdirSync(storage.userDataDir, { recursive: true });
    fs.writeFileSync(idFile, storageIdentityFileText(storage), "utf8");
  }
} catch {
  // Best effort: the next launch derives the same answer from the directory.
}

// One instance per userData dir. (The old "Pineapple Editor.app" does not take
// this lock, so both builds can still run side by side.)
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  const win = BaseWindow.getAllWindows().find((w) => !loginServices.passwordsWindow.owns(w));
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// App-scoped, not window-scoped (see mcp/service.ts's header): created once
// here and handed to every createMainWindow call, including the macOS dock
// "activate" reopen, so the HTTP server/token/handshake ownership survive a
// window close/reopen cycle instead of dying with the window.
const mcpService = createMcpService();

// Saved logins for the built-in browser — app-scoped for the same reason as
// mcpService: one store (and one "a save prompt is open" flag) for the whole
// app, not one per window. The cipher is Electron's safeStorage (macOS
// Keychain). Passwords exist as plaintext only inside the main process.
const credentialStore = createCredentialStore({
  filePath: path.join(app.getPath("userData"), CREDENTIALS_FILE),
  cipher: {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (cipher) => safeStorage.decryptString(cipher),
  },
});
// Site icons for the Passwords window: taken from the browser tabs' own favicon
// events and downloaded through their session (window.ts); cached per origin.
const faviconCache = createFaviconCache({
  filePath: path.join(app.getPath("userData"), FAVICONS_FILE),
  fs: nodeCredentialFs,
  fetchIcon: createIconFetcher((url, init) => session.fromPartition("persist:penbrowser").fetch(url, init)),
  isWanted: (origin) => credentialStore.list().some((e) => e.origin === origin),
  // A new icon arrived: an open Passwords window refreshes its tiles.
  onChange: () => loginServices.passwordsWindow.notifyChanged(),
});
const loginServices = {
  credentialStore,
  faviconCache,
  loginCapture: createLoginCapture(credentialStore),
  passwordsWindow: createPasswordsWindow(credentialStore, faviconCache),
};

app.whenReady().then(async () => {
  // The visible product name (app menu labels, About box). Safe now: the
  // userData path and the Keychain item name are already fixed above.
  app.setName(DISPLAY_APP_NAME);
  app.setAboutPanelOptions({ applicationName: DISPLAY_APP_NAME });
  // The editor must always open — MCP is a background convenience, not a
  // prerequisite. createMainWindow() runs first and unconditionally, before
  // mcpService.start() is even called, so neither a rejected start() (e.g.
  // startHttpServer failing to bind) nor probeHandshakeOwner's up-to-1500ms
  // liveness probe (handshake.ts, run when a stale handshake file points at
  // a blackholed address) can delay or block first paint. createMainWindow's
  // menu/tab-strip read mcpService.getStatus() at build time (starts "off"
  // either way) and rebuild themselves via mcpService.onStatusChanged when
  // start() actually resolves, so nothing here depends on start() having
  // already finished.
  // Built-in browser's dedicated session partition (see window.ts / design
  // doc §1) — a real browser tab with no chrome to ever reveal or revoke a
  // granted permission, so every permission request/check is denied
  // outright (finding 6). `session.fromPartition` needs the app to be
  // ready; `Session` objects for a given partition are singletons within
  // the app, and this must be set once, not per browser tab, so it lives
  // here rather than inside TabManager's per-tab createView.
  denyAllPermissions(session.fromPartition("persist:penbrowser"));

  createMainWindow(editorUrl, mcpService, loginServices);

  app.on("activate", () => {
    // The Passwords window is not a main window: it must not count here.
    if (shouldReopenMainWindow(BaseWindow.getAllWindows(), (w) => loginServices.passwordsWindow.owns(w))) createMainWindow(editorUrl, mcpService, loginServices);
  });

  try {
    // Bind → probe → publish or not (design doc §5).
    await mcpService.start();
  } catch (err) {
    console.error("[mcp] failed to start — the editor is unaffected, but MCP tools will be unavailable:", err);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Desktop apps the agent launched must not outlive us. Synchronous and non-blocking, no
// preventDefault and no delay (an async close would be cut off when the process exits):
// temp-profile apps are SIGKILLed and their profile removed; the user's own apps (restarted
// with their profile) get a detached helper that quits them and opens them again; nothing
// of the user's is killed.
app.on("before-quit", () => {
  appRegistry.killAllSync();
});

app.on("will-quit", () => {
  mcpService.teardownAppLevelIpc();
  // Synchronous: will-quit does not reliably await a returned promise, so
  // handshake-file removal must complete before this handler returns (see
  // handshake.ts's removeHandshakeFileSync comment). The HTTP server itself
  // is closed best-effort inside stop() without blocking shutdown on it.
  mcpService.stop();
});
