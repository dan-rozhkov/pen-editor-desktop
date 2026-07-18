import { app, BaseWindow } from "electron";
import { resolveEditorUrl } from "./config";
import { createMainWindow } from "./window";

const editorUrl = resolveEditorUrl(process.env);

app.whenReady().then(() => {
  createMainWindow(editorUrl);

  app.on("activate", () => {
    if (BaseWindow.getAllWindows().length === 0) createMainWindow(editorUrl);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
