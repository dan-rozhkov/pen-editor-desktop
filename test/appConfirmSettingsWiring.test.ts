import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => state.dir, isPackaged: false },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 2 })) },
}));

describe("appConfirm reads askAppAccess from the process-wide settings store", () => {
  it("does not ask for a normal app while the setting is off, and asks once it is on", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-wiring-"));
    const { getBrowserSettings } = await import("../src/main/browserSettingsInstance");
    const { appConfirm } = await import("../src/main/appTargetsService");
    const { dialog } = await import("electron");
    const app = { name: "Notes", realPath: "/Applications/Notes.app" };
    expect(await appConfirm.confirm({} as never, app, 1)).toBe(true);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    getBrowserSettings().set({ askAppAccess: true });
    expect(await appConfirm.confirm({} as never, app, 1)).toBe(false);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});

describe("getBrowserSettings is lazy", () => {
  it("does not touch app.getPath at import and resolves userData at the first call", async () => {
    vi.resetModules();
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { app } = await import("electron");
    const spy = vi.spyOn(app, "getPath");
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "settings-lazy-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "settings-lazy-b-"));
    state.dir = dirA;
    const mod = await import("../src/main/browserSettingsInstance");
    expect(spy).not.toHaveBeenCalled();
    state.dir = dirB; // "setPath" happens after the import
    const store = mod.getBrowserSettings();
    expect(spy).toHaveBeenCalledWith("userData");
    store.set({ askAppAccess: true });
    expect(fs.readdirSync(dirB).length).toBeGreaterThan(0);
    expect(fs.readdirSync(dirA)).toHaveLength(0);
    expect(mod.getBrowserSettings()).toBe(store);
  });
});
