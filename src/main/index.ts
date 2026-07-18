import { app, BrowserWindow } from "electron";
import { resolveEditorUrl } from "./config";

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 900 });
  void win.loadURL(resolveEditorUrl(process.env));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
