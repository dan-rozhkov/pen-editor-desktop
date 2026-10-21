import { describe, expect, it, vi } from "vitest";
import {
  APP_CONFIRM_HIGH_RISK_BUTTONS,
  APP_HIGH_RISK_WARNING,
  BLOCKED_BUNDLE_IDS,
  ERR_APP_BLOCKED,
  ERR_APP_DENIED,
  ERR_APP_NOT_ELECTRON,
  ERR_APP_OWN_BUNDLE,
  ERR_APP_QUIT_ON_LAUNCH,
  ERR_APP_RELEASED,
  HIGH_RISK_BUNDLE_IDS,
  NATIVE_HIGH_RISK_BUNDLE_IDS,
  createAppConfirm,
  createAppRegistry,
  isBlockedNativeApp,
  nativeRiskOf,
  errAppNotRunning,
  openApp,
  type AppPathResult,
  type ComputerUseDeps,
  type LaunchOptions,
} from "../src/main/appTargets";
import { ERR_NO_ACCESSIBILITY, NATIVE_MODE_NOTE } from "../src/main/computerUse/errors";
import type { RunningApp } from "../src/main/computerUse/appResolver";

const mk = (over: Partial<RunningApp> & { pid: number; name: string }): RunningApp => ({ active: false, hidden: false, ...over });
const notes = mk({ pid: 111, name: "Notes", bundleId: "com.apple.Notes", bundlePath: "/System/Applications/Notes.app" });

function fakeNative() {
  return {
    controller: { tabs: vi.fn(async () => ({ tabs: [{ tabId: 1, url: "macos-app://com.apple.Notes/7", title: "Note", current: true }], current: 1 })) },
    close: vi.fn(async () => {}),
    native: true as const,
    onDisconnected: (_cb: () => void) => {},
  };
}
type H = ReturnType<typeof fakeNative>;

function setup(over: {
  apps?: RunningApp[] | Error;
  answer?: "once" | "session" | "restart" | "deny";
  perms?: { accessibility: boolean; screenRecording: boolean };
  ownBundlePath?: string;
  restartable?: boolean;
  validate?: () => Promise<AppPathResult>;
  confirmAttach?: ComputerUseDeps["confirmAttach"];
  noComputerUse?: boolean;
} = {}) {
  const launch = vi.fn(async (_p: string, _o?: LaunchOptions) => fakeNative());
  const reg = createAppRegistry<H>({ launch });
  const apps = over.apps ?? [notes];
  const cu = {
    listApps: vi.fn(async () => {
      if (apps instanceof Error) throw apps;
      return apps;
    }),
    windowTitles: vi.fn(async (_pid: number) => [] as string[]),
    realpath: vi.fn(async (p: string) => p),
    permissions: vi.fn(async (_prompt: boolean) => over.perms ?? { accessibility: true, screenRecording: true }),
    openAccessibilitySettings: vi.fn(),
    confirmAttach: vi.fn(over.confirmAttach ?? (async () => over.answer ?? "once")),
    ownBundlePath: over.ownBundlePath,
    isRestartable: vi.fn(async () => over.restartable ?? true),
  };
  const validate = vi.fn(over.validate ?? (async (): Promise<AppPathResult> => ({ ok: false, error: ERR_APP_NOT_ELECTRON })));
  const confirm = vi.fn(async () => true);
  const confirmRestart = vi.fn(async () => true);
  const findRunning = vi.fn(async (_p: string) => [] as number[]);
  const run = (requested: unknown = "Notes", key = "1:") =>
    openApp(key, requested, {
      registry: reg,
      validate,
      confirm,
      findRunning,
      confirmRestart,
      quit: async () => true,
      reopen: async () => {},
      ...(over.noComputerUse ? {} : { computerUse: cu }),
    });
  return { reg, launch, cu, validate, confirm, confirmRestart, run };
}

describe("openApp: native attach", () => {
  it("attaches with the native pid and returns mode + note", async () => {
    const t = setup();
    const res = await t.run("notes");
    expect(res).toMatchObject({ app: "Notes", url: "macos-app://com.apple.Notes/7", title: "Note", mode: "computer-use", note: NATIVE_MODE_NOTE });
    expect(t.launch).toHaveBeenCalledWith("/System/Applications/Notes.app", { native: { pid: 111 } });
    expect(t.validate).not.toHaveBeenCalled();
    expect(t.reg.state("1:")).toBe("running");
    expect(t.cu.permissions).toHaveBeenCalledWith(false);
  });
  it("uses the app name when there is no bundle path", async () => {
    const t = setup({ apps: [mk({ pid: 5, name: "Weird", bundleId: "x.y" })] });
    await t.run("weird");
    expect(t.launch).toHaveBeenCalledWith("Weird", { native: { pid: 5 } });
  });
  it("refuses blocked bundle ids BEFORE the confirm, including the new password managers", async () => {
    for (const id of ["com.apple.Passwords", "com.apple.keychainaccess", "com.1password.1password"]) {
      const t = setup({ apps: [mk({ pid: 9, name: "PM", bundleId: id, bundlePath: "/Applications/PM.app" })] });
      expect(await t.run("pm")).toEqual({ error: ERR_APP_BLOCKED });
      expect(t.cu.confirmAttach).not.toHaveBeenCalled();
      expect(t.launch).not.toHaveBeenCalled();
      expect(t.reg.state("1:")).toBe("none");
    }
    expect(BLOCKED_BUNDLE_IDS.has("com.apple.passwords")).toBe(true);
    expect(BLOCKED_BUNDLE_IDS.has("com.apple.keychainaccess")).toBe(true);
  });
  it("refuses the added password managers by id and any password-like name or id by heuristic", async () => {
    const apps = [
      mk({ pid: 9, name: "KeePassXC", bundleId: "org.keepassxc.keepassxc" }),
      mk({ pid: 9, name: "MacPass", bundleId: "com.hicknhacksoftware.MacPass" }),
      mk({ pid: 9, name: "Strongbox", bundleId: "com.markmcguill.strongbox.mac.paid" }),
      mk({ pid: 9, name: "LastPass", bundleId: "com.lastpass.LastPass" }),
      mk({ pid: 9, name: "Bitwarden", bundleId: "com.8bit.bitwarden" }),
      mk({ pid: 9, name: "Acme Vault", bundleId: "com.acme.PasswordSafe" }),
      mk({ pid: 9, name: "Proton Pass", bundleId: "com.acme.x" }),
      mk({ pid: 9, name: "Authenticator", bundleId: "com.acme.y" }),
      mk({ pid: 9, name: "Secrets", bundleId: "com.acme.z" }),
    ];
    for (const a of apps) {
      const t = setup({ apps: [a] });
      expect(await t.run(a.name)).toEqual({ error: ERR_APP_BLOCKED });
      expect(t.cu.confirmAttach).not.toHaveBeenCalled();
    }
  });
  it("refuses Sideform itself", async () => {
    const t = setup({ ownBundlePath: "/Applications/Sideform Desktop.app", apps: [mk({ pid: 2, name: "Sideform Desktop", bundleId: "com.peneditor.desktop", bundlePath: "/Applications/Sideform Desktop.app" })] });
    expect(await t.run("sideform desktop")).toEqual({ error: ERR_APP_OWN_BUNDLE });
    expect(t.cu.confirmAttach).not.toHaveBeenCalled();
  });
  it("high risk (terminal, messenger, no bundle id) passes canRestart false and risk high", async () => {
    for (const a of [
      mk({ pid: 3, name: "Terminal", bundleId: "com.apple.Terminal", bundlePath: "/System/Applications/Utilities/Terminal.app" }),
      mk({ pid: 4, name: "Slack", bundleId: "com.tinyspeck.slackmacgap", bundlePath: "/Applications/Slack.app" }),
      mk({ pid: 6, name: "NoId", bundlePath: "/Applications/NoId.app" }),
    ]) {
      const t = setup({ apps: [a], restartable: true });
      await t.run(a.name);
      expect(t.cu.confirmAttach).toHaveBeenCalledWith(expect.objectContaining({ risk: "high", canRestart: false }));
    }
  });
  it("normal risk offers restart only when restartable and the app has a bundle path", async () => {
    const yes = setup({ restartable: true });
    await yes.run("notes");
    expect(yes.cu.confirmAttach).toHaveBeenCalledWith({ name: "Notes", key: "com.apple.Notes", risk: "normal", canRestart: true });
    const no = setup({ restartable: false });
    await no.run("notes");
    expect(no.cu.confirmAttach).toHaveBeenCalledWith(expect.objectContaining({ canRestart: false }));
  });
  it("a native launch that fails (watch: the app quit during the confirm) returns an error and frees the key", async () => {
    const t = setup();
    t.launch.mockRejectedValueOnce(new Error(ERR_APP_QUIT_ON_LAUNCH));
    expect(await t.run("notes")).toEqual({ error: ERR_APP_QUIT_ON_LAUNCH });
    expect(t.reg.state("1:")).toBe("none");
  });
  it("deny launches nothing and frees the key", async () => {
    const t = setup({ answer: "deny" });
    expect(await t.run("notes")).toEqual({ error: ERR_APP_DENIED });
    expect(t.launch).not.toHaveBeenCalled();
    expect(t.cu.permissions).not.toHaveBeenCalled();
    expect(t.reg.state("1:")).toBe("none");
  });
  it("once and session both attach", async () => {
    for (const answer of ["once", "session"] as const) {
      const t = setup({ answer });
      expect(await t.run("notes")).toMatchObject({ mode: "computer-use" });
    }
  });
  it("restart falls through to today's path with the bundle path as input", async () => {
    const t = setup({ answer: "restart" });
    expect(await t.run("notes")).toEqual({ error: ERR_APP_NOT_ELECTRON + " To control an app without a restart, it must be running. Running apps: Notes." });
    expect(t.validate).toHaveBeenCalledWith("/System/Applications/Notes.app");
    expect(t.launch).not.toHaveBeenCalled();
  });
  it("without Accessibility: prompts, opens the settings, errors and does NOT launch", async () => {
    const t = setup({ perms: { accessibility: false, screenRecording: false } });
    expect(await t.run("notes")).toEqual({ error: ERR_NO_ACCESSIBILITY });
    expect(t.cu.permissions.mock.calls.map((c) => c[0])).toEqual([false, true]);
    expect(t.cu.openAccessibilitySettings).toHaveBeenCalledTimes(1);
    expect(t.launch).not.toHaveBeenCalled();
    expect(t.reg.state("1:")).toBe("none");
  });
  it("cancelled during the confirm: released, nothing launched", async () => {
    let resolve!: (v: "once") => void;
    const t = setup({ confirmAttach: () => new Promise((r) => (resolve = r)) });
    const p = t.run("notes");
    await vi.waitFor(() => expect(t.cu.confirmAttach).toHaveBeenCalled());
    const rel = t.reg.release("1:");
    resolve("once");
    await rel;
    expect(await p).toEqual({ error: ERR_APP_RELEASED });
    expect(t.launch).not.toHaveBeenCalled();
  });
  it("not running: today's path; a validate failure lists running apps", async () => {
    const t = setup({ apps: [notes, mk({ pid: 1, name: "Finder", bundleId: "com.apple.finder", active: true })] });
    expect(await t.run("/Applications/Missing.app")).toEqual({ error: errAppNotRunning(ERR_APP_NOT_ELECTRON, ["Finder", "Notes"]) });
    expect(t.validate).toHaveBeenCalledWith("/Applications/Missing.app");
    expect(t.cu.confirmAttach).not.toHaveBeenCalled();
  });
  it("the running-apps hint lists neither blocked nor high-risk apps", async () => {
    const t = setup({
      apps: [
        notes,
        mk({ pid: 2, name: "Bitwarden", bundleId: "com.bitwarden.desktop" }),
        mk({ pid: 3, name: "My Vault", bundleId: "x.passwordvault" }),
        mk({ pid: 4, name: "Mail", bundleId: "com.apple.mail" }),
        mk({ pid: 5, name: "Terminal", bundleId: "com.apple.Terminal" }),
        mk({ pid: 6, name: "NoId" }),
      ],
    });
    expect(await t.run("/Applications/Missing.app")).toEqual({ error: errAppNotRunning(ERR_APP_NOT_ELECTRON, ["Notes"]) });
  });
  it("window-title matching never reads the windows of blocked or high-risk apps", async () => {
    const t = setup({
      apps: [
        mk({ pid: 2, name: "Vault", bundleId: "org.keepassxc.keepassxc" }),
        mk({ pid: 3, name: "Mail", bundleId: "com.apple.mail" }),
        mk({ pid: 4, name: "Doc", bundleId: "com.example.doc" }),
      ],
    });
    t.cu.windowTitles.mockImplementation(async (pid: number) => (pid === 4 ? ["Quarterly plan"] : ["Quarterly plan"]));
    await t.run("quarterly plan");
    expect(t.cu.windowTitles.mock.calls.map((c) => c[0])).toEqual([4]);
    expect(t.launch).toHaveBeenCalledWith("Doc", { native: { pid: 4 } });
  });
  it("a validate failure that is not about the path gets no hint", async () => {
    const t = setup({ validate: async () => ({ ok: false, error: ERR_APP_BLOCKED }) });
    expect(await t.run("/Applications/Missing.app")).toEqual({ error: ERR_APP_BLOCKED });
  });
  it("a listApps failure falls back to today's path unchanged", async () => {
    const t = setup({ apps: new Error("helper died") });
    expect(await t.run("notes")).toEqual({ error: ERR_APP_NOT_ELECTRON });
    expect(t.validate).toHaveBeenCalled();
  });
  it("without computerUse nothing changes", async () => {
    const t = setup({ noComputerUse: true });
    expect(await t.run("notes")).toEqual({ error: ERR_APP_NOT_ELECTRON });
    expect(t.cu.listApps).not.toHaveBeenCalled();
  });
  it("a native handle passes the registry's isAlive check and counts in the cap", async () => {
    const launch = vi.fn(async () => fakeNative());
    const reg = createAppRegistry<H>({ launch, isAlive: () => false, maxApps: 1 });
    const b = reg.begin("1:");
    if (!b.ok) throw new Error("begin");
    expect((await b.ticket.launch("/x", { native: { pid: 1 } })).ok).toBe(true);
    expect(reg.livePids()).toEqual([]);
    expect(reg.size()).toBe(1);
    expect(reg.begin("2:")).toMatchObject({ ok: false });
  });
});

describe("isBlockedNativeApp / nativeRiskOf", () => {
  it("matches by id list and by heuristic, case-insensitive", () => {
    expect(isBlockedNativeApp({ name: "x", bundleId: "COM.LASTPASS.LASTPASS" })).toBe(true);
    expect(isBlockedNativeApp({ name: "Proton  Pass" })).toBe(false); // two spaces: not the pattern
    expect(isBlockedNativeApp({ name: "ProtonPass" })).toBe(true);
    expect(isBlockedNativeApp({ name: "Notes", bundleId: "com.apple.Notes" })).toBe(false);
  });
  it("risk: blocked, high (list or no id), normal", () => {
    expect(nativeRiskOf({ name: "1Password" })).toBe("blocked");
    expect(nativeRiskOf({ name: "Mail", bundleId: "com.apple.mail" })).toBe("high");
    expect(nativeRiskOf({ name: "X" })).toBe("high");
    expect(nativeRiskOf({ name: "Notes", bundleId: "com.apple.Notes" })).toBe("normal");
  });
  it("the native high-risk list has the added messengers, mail and automation apps", () => {
    for (const id of ["com.apple.mail", "com.apple.MobileSMS", "com.apple.iChat", "ru.keepcoder.Telegram", "org.telegram.desktop", "net.whatsapp.WhatsApp", "desktop.WhatsApp", "com.microsoft.Outlook", "org.whispersystems.signal-desktop", "com.tinyspeck.slackmacgap", "com.hnc.Discord", "com.apple.ScriptEditor2", "com.apple.Automator"]) {
      expect(NATIVE_HIGH_RISK_BUNDLE_IDS.has(id.toLowerCase())).toBe(true);
    }
  });
});

describe("native high-risk list", () => {
  it("extends today's list with terminals and settings", () => {
    for (const id of HIGH_RISK_BUNDLE_IDS) expect(NATIVE_HIGH_RISK_BUNDLE_IDS.has(id)).toBe(true);
    for (const id of ["com.apple.terminal", "com.googlecode.iterm2", "com.apple.systempreferences", "com.apple.settings"]) {
      expect(NATIVE_HIGH_RISK_BUNDLE_IDS.has(id)).toBe(true);
    }
  });
});

describe("createAppConfirm.confirmAttach", () => {
  type Opts = { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number };
  const make = (...responses: number[]) => {
    const q = [...responses];
    const showMessageBox = vi.fn(async (_w: string, _o: Opts) => ({ response: q.shift() ?? 0 }));
    return { c: createAppConfirm<string>({ showMessageBox }), showMessageBox };
  };
  const app = { name: "Notes", key: "com.apple.Notes", risk: "normal" as const, canRestart: false };
  it("shows the message, detail and three buttons", async () => {
    const { c, showMessageBox } = make(0);
    expect(await c.confirmAttach("w", app, 1)).toBe("once");
    const o = showMessageBox.mock.calls[0][1];
    expect(o.message).toBe('Let the AI agent control "Notes"?');
    expect(o.detail).toContain("not restarted");
    expect(o.detail).toContain("Accessibility and Screen Recording");
    expect(o.buttons).toEqual(["Allow once", "Allow until Sideform quits", "Don't allow"]);
    expect(o.defaultId).toBe(2);
    expect(o.cancelId).toBe(2);
  });
  it("adds the restart button when canRestart and maps it", async () => {
    const { c, showMessageBox } = make(2, 3);
    expect(await c.confirmAttach("w", { ...app, canRestart: true }, 1)).toBe("restart");
    expect(showMessageBox.mock.calls[0][1].buttons).toEqual(["Allow once", "Allow until Sideform quits", "Restart with full access", "Don't allow"]);
    expect(await c.confirmAttach("w", { ...app, canRestart: true }, 1)).toBe("deny");
  });
  it("high risk: two buttons and the warning, never memoized", async () => {
    const { c, showMessageBox } = make(0, 0);
    const risky = { ...app, risk: "high" as const, canRestart: true };
    expect(await c.confirmAttach("w", risky, 1)).toBe("once");
    expect(await c.confirmAttach("w", risky, 1)).toBe("once");
    const o = showMessageBox.mock.calls[0][1];
    expect(o.buttons).toEqual([...APP_CONFIRM_HIGH_RISK_BUTTONS]);
    expect(o.detail).toContain(APP_HIGH_RISK_WARNING);
    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });
  it("'until quits' is remembered per key and owner and returns session", async () => {
    const { c, showMessageBox } = make(1, 0, 0);
    expect(await c.confirmAttach("w", app, 1)).toBe("session");
    expect(await c.confirmAttach("w", app, 1)).toBe("session");
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(await c.confirmAttach("w", app, 2)).toBe("once"); // other owner asks again
    expect(await c.confirmAttach("w", { ...app, key: "other" }, 1)).toBe("once"); // other key asks again
  });
  it("forgetSender drops the attach memo", async () => {
    const { c, showMessageBox } = make(1, 0);
    await c.confirmAttach("w", app, 1);
    c.forgetSender(1);
    expect(await c.confirmAttach("w", app, 1)).toBe("once");
    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });
  it("does not share memo with the launch confirm", async () => {
    const { c, showMessageBox } = make(1, 0);
    await c.confirm("w", { name: "Notes", realPath: "com.apple.Notes" }, 1);
    expect(await c.confirmAttach("w", app, 1)).toBe("once");
    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });
});
