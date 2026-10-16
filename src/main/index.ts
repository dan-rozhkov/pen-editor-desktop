import path from "node:path";
import { app, BaseWindow, safeStorage, session } from "electron";
import { resolveEditorUrl, resolveUserDataDir } from "./config";
import { createMainWindow } from "./window";
import { createMcpService } from "./mcp/service";
import { denyAllPermissions } from "./browser/permissions";
import { CREDENTIALS_FILE, createCredentialStore } from "./browser/credentialStore";
import { createLoginCapture } from "./browser/loginCapture";
import { createPasswordsWindow } from "./passwordsWindow";
import { shouldReopenMainWindow } from "./closeTarget";

const editorUrl = resolveEditorUrl(process.env);

// `electron .` otherwise appears as "Electron" in the macOS menu bar during
// development. Packaged builds also use the same user-facing product name.
app.setName("Pineapple Editor");

// e2e gives every run a fresh userData dir so saved settings never leak in
// (PEN_DESKTOP_USER_DATA_DIR). Must run before app.ready.
const userDataDir = resolveUserDataDir(process.env);
if (userDataDir) app.setPath("userData", userDataDir);

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
const loginServices = {
  credentialStore,
  loginCapture: createLoginCapture(credentialStore),
  passwordsWindow: createPasswordsWindow(credentialStore),
};

app.whenReady().then(async () => {
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

app.on("will-quit", () => {
  mcpService.teardownAppLevelIpc();
  // Synchronous: will-quit does not reliably await a returned promise, so
  // handshake-file removal must complete before this handler returns (see
  // handshake.ts's removeHandshakeFileSync comment). The HTTP server itself
  // is closed best-effort inside stop() without blocking shutdown on it.
  mcpService.stop();
});
