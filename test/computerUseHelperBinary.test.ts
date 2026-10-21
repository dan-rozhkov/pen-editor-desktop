import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Darwin-only: drives the real Swift helper when it has been built (`npm run build:native`).
const binPath = join(__dirname, "..", "native", "bin", "sideform-computer-use");

type Reply = { id: number; ok: boolean; error?: string; code?: string; [k: string]: unknown };

describe.skipIf(process.platform !== "darwin" || !existsSync(binPath))("sideform-computer-use binary", () => {
  let child: ChildProcessWithoutNullStreams;
  const pending = new Map<number, (r: Reply) => void>();
  let nextId = 0;

  beforeAll(() => {
    child = spawn(binPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      const msg = JSON.parse(line) as Reply;
      pending.get(msg.id)?.(msg);
    });
  });

  afterAll(() => {
    child?.kill();
  });

  function call(cmd: string, args: Record<string, unknown> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`${cmd} did not answer`)), 8000);
      pending.set(id, (r) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(r);
      });
      child.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
    });
  }

  it("answers ping with the protocol version and echoes the id", async () => {
    const r = await call("ping");
    expect(r).toMatchObject({ ok: true, version: 1 });
    expect(r.id).toBe(nextId);
  });

  it("reports both permissions as booleans", async () => {
    const r = await call("permissions");
    expect(r.ok).toBe(true);
    expect(typeof r.accessibility).toBe("boolean");
    expect(typeof r.screenRecording).toBe("boolean");
  });

  it("lists regular apps with pid and name", async () => {
    const r = await call("listApps");
    expect(r.ok).toBe(true);
    const apps = r.apps as Array<{ pid: number; name: string; active: boolean; hidden: boolean }>;
    expect(Array.isArray(apps)).toBe(true);
    expect(apps.length).toBeGreaterThan(0);
    for (const a of apps) {
      expect(typeof a.pid).toBe("number");
      expect(typeof a.name).toBe("string");
      expect(typeof a.active).toBe("boolean");
      expect(typeof a.hidden).toBe("boolean");
    }
  });

  it("lists windows of a listed app, or fails with NO_ACCESSIBILITY", async () => {
    const { apps } = (await call("listApps")) as unknown as { apps: Array<{ pid: number }> };
    const r = await call("windows", { pid: apps[0].pid });
    if (r.ok) {
      expect(Array.isArray(r.windows)).toBe(true);
      for (const w of r.windows as Array<Record<string, unknown>>) {
        expect(typeof w.windowId).toBe("number");
        expect(typeof w.width).toBe("number");
        expect(typeof w.onScreen).toBe("boolean");
      }
    } else {
      expect(r.code).toBe("NO_ACCESSIBILITY");
    }
  });

  it("answers errors with a code instead of staying silent", async () => {
    expect(await call("windows", { pid: 999999 })).toMatchObject({ ok: false, code: expect.stringMatching(/NOT_FOUND|NO_ACCESSIBILITY/) });
    expect(await call("elementFrame", { snapshotId: "none", index: 0 })).toMatchObject({ ok: false, code: "STALE" });
    expect(await call("nope")).toMatchObject({ ok: false, code: "BAD_ARGS" });
    expect(await call("windows", {})).toMatchObject({ ok: false });
  });
});
