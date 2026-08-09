import { app, BaseWindow } from "electron";
import { resolveEditorUrl } from "./config";
import { createMainWindow } from "./window";
import { createMcpService } from "./mcp/service";

const editorUrl = resolveEditorUrl(process.env);

// `electron .` otherwise appears as "Electron" in the macOS menu bar during
// development. Packaged builds also use the same user-facing product name.
app.setName("Pineapple Editor");

// App-scoped, not window-scoped (see mcp/service.ts's header): created once
// here and handed to every createMainWindow call, including the macOS dock
// "activate" reopen, so the HTTP server/token/handshake ownership survive a
// window close/reopen cycle instead of dying with the window.
const mcpService = createMcpService();

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
  createMainWindow(editorUrl, mcpService);

  app.on("activate", () => {
    if (BaseWindow.getAllWindows().length === 0) createMainWindow(editorUrl, mcpService);
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
