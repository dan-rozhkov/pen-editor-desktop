// The lazy singleton `sideform-computer-use` helper process and the availability check.
// Kept apart from service.ts so appTargetsService.ts can use it without an import cycle.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app, nativeImage } from "electron";
import { ComputerUseHelper, type ChildLike } from "./helperClient";
import type { NativeControllerDeps } from "./nativeController";

export const HELPER_NAME = "sideform-computer-use";

/** Packaged: next to the app resources (electron-builder extraResources). Dev: <repo>/native/bin (getAppPath is the repo root; main is dist/main/index.js). */
export const helperBinaryPath = (): string =>
  app.isPackaged ? path.join(process.resourcesPath, "computer-use", HELPER_NAME) : path.join(app.getAppPath(), "native/bin", HELPER_NAME);

let available: boolean | undefined;
export const computerUseAvailable = (): boolean => (available ??= process.platform === "darwin" && existsSync(helperBinaryPath()));

let helper: ComputerUseHelper | undefined;
let quitHooked = false;

export function getHelper(): ComputerUseHelper {
  if (helper) return helper;
  helper = new ComputerUseHelper({
    binPath: helperBinaryPath(),
    spawn: (bin) => spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildLike,
    onLog: (line) => console.log(`[computer-use] ${line}`),
  });
  if (!quitHooked) {
    quitHooked = true;
    app.on("will-quit", () => {
      helper?.close();
      helper = undefined;
    });
  }
  return helper;
}

let cursorEnabled: () => boolean = () => true;
/** The "Show Agent Cursor" setting, read at each cursor move (window.ts supplies it). */
export const setNativeCursorEnabled = (fn: () => boolean): void => {
  cursorEnabled = fn;
};
export const nativeCursorEnabled = (): boolean => cursorEnabled();

/** PNG (base64) to JPEG 80 ≤ maxWidth px. */
export const encodeImageForAgent: NonNullable<NativeControllerDeps["encodeImage"]> = (pngBase64, maxWidth) => {
  let img = nativeImage.createFromBuffer(Buffer.from(pngBase64, "base64"));
  const size = img.getSize();
  if (size.width > maxWidth) img = img.resize({ width: maxWidth });
  const out = img.getSize();
  return { data: img.toJPEG(80).toString("base64"), width: out.width, height: out.height, mimeType: "image/jpeg" };
};
