import fs from "node:fs";
import path from "node:path";
import { app, BaseWindow, ipcMain, safeStorage, session, shell } from "electron";
import { KEEP_RENDERING_WHEN_OCCLUDED_SWITCH } from "./agentActivity";
import { DISPLAY_APP_NAME, STORAGE_IDENTITY_FILE, resolveEditorUrl, resolveStorageIdentity, storageIdentityFileText } from "./config";
import { createMainWindow } from "./window";
import { appRegistry } from "./appTargetsService";
import { createMcpService } from "./mcp/service";
import { denyAllPermissions } from "./browser/permissions";
import { CREDENTIALS_FILE, createCredentialStore, nodeCredentialFs } from "./browser/credentialStore";
import { FAVICONS_FILE, createFaviconCache, createIconFetcher } from "./browser/faviconCache";
import { createLoginCapture } from "./browser/loginCapture";
import { createPasswordsService } from "./passwordsService";
import { shouldReopenMainWindow } from "./closeTarget";
import { isCursorOverlayWindow } from "./computerUse/cursorOverlay";
import { DEEP_LINK_SCHEME, createDesktopAuth, parseDeepLinkArg, resolveProtocolRegistration, shouldRegisterProtocol, systemDeps } from "./desktopAuth";
import { runOriginMigrationOnStartup } from "./originMigrationRunner";
import { createMigrationGuard } from "./migrationGuard";

const editorUrl = resolveEditorUrl(process.env);

// A window covered by another app's window must keep rendering, or the agent's browser tab freezes
// (rAF stops, screenshots come back empty). Cost: the editor canvas also keeps rendering while
// covered; it renders on demand, so the idle cost is small. Must run before ready.
app.commandLine.appendSwitch(KEEP_RENDERING_WHEN_OCCLUDED_SWITCH);

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

// Deep link sign-in (desktopAuth.ts). The state of a sign-in attempt lives in memory only, so a link
// that arrives without a matching attempt (a cold start, a stale link) is ignored by design.
const desktopAuth = createDesktopAuth({
  ...systemDeps,
  editorOrigin: new URL(editorUrl).origin,
  openExternal: (url) => shell.openExternal(url),
  log: (m) => console.log(`[auth] ${m}`),
});
// Links that arrive before the main window exists wait here; `open-url` on macOS can fire
// before `ready`, so the listener is registered now, at module level.
let windowCreated = false;
const queuedDeepLinks: string[] = [];
// The one way to open a main window after startup (dock "activate", a deep link or a second launch
// while every window is closed on macOS). Needs the services created further down, hence a function.
function openMainWindowIfNone(): void {
  if (startup.active) return; // the hidden migration window is not a main window
  // An agent cursor overlay is not a main window.
  if (shouldReopenMainWindow(BaseWindow.getAllWindows(), isCursorOverlayWindow)) createMainWindow(editorUrl, mcpService, loginServices, desktopAuth);
}
function dispatchDeepLink(url: string): void {
  // Validate FIRST: only a well-formed sideform://auth link whose state matches the pending attempt may
  // queue, open a window or reach the editor. handleDeepLink logs why anything else is ignored.
  if (!desktopAuth.wouldAccept(url)) {
    desktopAuth.handleDeepLink(url);
    return;
  }
  if (!windowCreated) {
    queuedDeepLinks.push(url);
    return;
  }
  // macOS: the app can be alive with no window. Open one; a token no view listens to yet is held
  // in desktopAuth and delivered when the new window's page calls auth.onToken.
  openMainWindowIfNone();
  desktopAuth.handleDeepLink(url);
}
function markWindowCreated(): void {
  windowCreated = true;
  for (const url of queuedDeepLinks.splice(0)) desktopAuth.handleDeepLink(url);
}
app.on("open-url", (event, url) => {
  event.preventDefault();
  dispatchDeepLink(url);
});
{
  // An unpackaged run (npm run dev, Playwright e2e) would steal sideform:// from the installed app:
  // it registers only with PEN_DESKTOP_REGISTER_PROTOCOL=1.
  if (shouldRegisterProtocol(process.defaultApp, process.env)) {
    const reg = resolveProtocolRegistration(process.defaultApp, process.execPath, process.argv[1], path.resolve);
    const ok = reg.args ? app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, reg.args[0], reg.args[1]) : app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    if (!ok) console.warn("[auth] could not register the sideform:// protocol; browser sign-in will not return to the app");
  }
  const initial = parseDeepLinkArg(process.argv);
  if (initial) dispatchDeepLink(initial);
}

app.on("second-instance", (_event, argv) => {
  const link = parseDeepLinkArg(argv);
  if (link) dispatchDeepLink(link);
  // While the startup guard is active the only window is the hidden migration window: never show it.
  if (startup.active) return;
  const win = BaseWindow.getAllWindows().find((w) => !isCursorOverlayWindow(w));
  if (!win) {
    openMainWindowIfNone();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// App-scoped, not window-scoped (see mcp/service.ts's header): created once
// here and handed to every createMainWindow call, including the macOS dock
// "activate" reopen, so the HTTP server/token/handshake ownership survive a
// window close/reopen cycle instead of dying with the window.
const mcpService = createMcpService();

// Set by before-quit; checked after the migration await so a quit during startup creates nothing.
let quitting = false;

// The hidden migration window is the only window until the main one exists; destroying it would fire
// window-all-closed and quit the app (Windows/Linux). The guard covers the whole startup phase.
const startup = createMigrationGuard();

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
// Site icons for the Passwords tab: taken from the browser tabs' own favicon
// events and downloaded through their session (window.ts); cached per origin.
const faviconCache = createFaviconCache({
  filePath: path.join(app.getPath("userData"), FAVICONS_FILE),
  fs: nodeCredentialFs,
  fetchIcon: createIconFetcher((url, init) => session.fromPartition("persist:penbrowser").fetch(url, init)),
  isWanted: (origin) => credentialStore.list().some((e) => e.origin === origin),
  // A new icon arrived: an open Passwords tab refreshes its row icons.
  onChange: () => loginServices.passwords.notifyChanged(),
});
const loginServices = {
  credentialStore,
  faviconCache,
  loginCapture: createLoginCapture(credentialStore),
  passwords: createPasswordsService(credentialStore, faviconCache, { ipcMain }),
};

app.whenReady().then(async () => {
  // The visible product name (app menu labels, About box). Safe now: the
  // userData path and the Keychain item name are already fixed above.
  app.setName(DISPLAY_APP_NAME);
  app.setAboutPanelOptions({ applicationName: DISPLAY_APP_NAME });
  // The editor must always open — MCP is a background convenience, not a
  // prerequisite. createMainWindow() runs first (only the bounded, never-throwing origin migration precedes it) and unconditionally, before
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

  // Registered BEFORE the migration is awaited. Until the first main window exists it does nothing:
  // opening an editor window earlier would let the new origin mint its own pen.userId before the import.
  app.on("activate", () => {
    openMainWindowIfNone();
  });

  // Copy the old origin's localStorage/IndexedDB into the new one (once). Bounded to 5 s, never throws,
  // fails fast offline; a failure only means "try again next launch". The main window waits for it:
  // the import must land before the editor on the new origin can create its own pen.userId.
  await runOriginMigrationOnStartup(editorUrl, process.env);

  // The user quit while the migration ran: do not create a window or start MCP behind their back.
  if (quitting) return;

  createMainWindow(editorUrl, mcpService, loginServices, desktopAuth);
  markWindowCreated();
  startup.end();

  try {
    // Bind → probe → publish or not (design doc §5).
    await mcpService.start();
  } catch (err) {
    console.error("[mcp] failed to start — the editor is unaffected, but MCP tools will be unavailable:", err);
  }
});

app.on("window-all-closed", () => {
  if (startup.active) return; // the hidden migration window was the only window
  if (process.platform !== "darwin") app.quit();
});

// Desktop apps the agent launched must not outlive us. Synchronous and non-blocking, no
// preventDefault and no delay (an async close would be cut off when the process exits):
// temp-profile apps are SIGKILLed and their profile removed; the user's own apps (restarted
// with their profile) get a detached helper that quits them and opens them again; nothing
// of the user's is killed.
app.on("before-quit", () => {
  quitting = true;
  appRegistry.killAllSync();
});

app.on("will-quit", () => {
  mcpService.teardownAppLevelIpc();
  loginServices.passwords.dispose();
  // Synchronous: will-quit does not reliably await a returned promise, so
  // handshake-file removal must complete before this handler returns (see
  // handshake.ts's removeHandshakeFileSync comment). The HTTP server itself
  // is closed best-effort inside stop() without blocking shutdown on it.
  mcpService.stop();
});
