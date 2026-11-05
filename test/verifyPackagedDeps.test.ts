import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require_ = createRequire(path.join(__dirname, "x.js"));
const hook = require_("../scripts/verify-packaged-deps.cjs");
const asar = require_("@electron/asar");
const { expectedProdPackages, packagedPackages, findMissingPackages } = hook;
const verifyPackagedDeps = hook.afterPack as (ctx: unknown) => Promise<void>;

type Entry = { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
const lockOf = (root: Entry, rest: Record<string, Entry>) => ({ lockfileVersion: 3, packages: { "": root, ...rest } });

describe("expectedProdPackages", () => {
  it("prefers the nested copy and follows transitive dependencies", () => {
    const lock = lockOf({ dependencies: { a: "1" } }, {
      "node_modules/a": { dependencies: { x: "1" } },
      "node_modules/a/node_modules/x": { dependencies: { onlyNested: "1" } },
      "node_modules/a/node_modules/onlyNested": {},
      "node_modules/x": {},
    });
    expect(expectedProdPackages(lock)).toEqual(["a", "onlyNested", "x"]);
  });

  it("does not follow peer, dev or optional dependencies", () => {
    const lock = lockOf({ dependencies: { a: "1" } }, {
      "node_modules/a": {
        dependencies: { real: "1" },
        peerDependencies: { peer: "1" },
        devDependencies: { dev: "1" },
        optionalDependencies: { opt: "1" },
      },
      "node_modules/real": {},
    });
    expect(expectedProdPackages(lock)).toEqual(["a", "real"]);
  });

  it("ends on a cycle", () => {
    const lock = lockOf({ dependencies: { a: "1" } }, {
      "node_modules/a": { dependencies: { b: "1" } },
      "node_modules/b": { dependencies: { a: "1" } },
    });
    expect(expectedProdPackages(lock)).toEqual(["a", "b"]);
  });

  it("throws and names an unresolved required dependency", () => {
    const lock = lockOf({ dependencies: { a: "1" } }, { "node_modules/a": { dependencies: { ghost: "1" } } });
    expect(() => expectedProdPackages(lock)).toThrow(/ghost/);
  });

  it("matches the real lockfile", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8"));
    const names = expectedProdPackages(lock);
    // Read the names from the lockfile: a dependency bump must not fail this test.
    const direct = Object.keys(lock.packages[""].dependencies);
    const transitive = direct.flatMap((n: string) => Object.keys(lock.packages[`node_modules/${n}`].dependencies ?? {}));
    expect(transitive.length).toBeGreaterThan(0);
    for (const n of [...direct, ...transitive]) expect(names).toContain(n);
    for (const n of ["electron", "vitest"]) expect(names).not.toContain(n);
  });
});

describe("packagedPackages", () => {
  it("handles scoped, nested and ignores deep package.json files", () => {
    const paths = [
      "/package.json",
      "/node_modules/foo/package.json",
      "/node_modules/foo/dist/esm/package.json",
      "/node_modules/@s/bar/package.json",
      "/node_modules/@s/bar/node_modules/baz/package.json",
      "\\node_modules\\win\\package.json",
      "/node_modules/foo/index.js",
    ];
    expect(packagedPackages(paths)).toEqual(["@s/bar", "baz", "foo", "win"]);
  });
});

describe("findMissingPackages", () => {
  it("returns expected names that are absent", () => {
    expect(findMissingPackages(["a", "b", "c"], ["a", "c", "z"])).toEqual(["b"]);
    expect(findMissingPackages(["a"], ["a"])).toEqual([]);
  });
});

describe("verifyPackagedDeps", () => {
  let dir: string;
  beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "verifydeps-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const makeCtx = async (pkgs: string[]) => {
    const projectDir = path.join(dir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "package-lock.json"), JSON.stringify(lockOf({ dependencies: { a: "1" } }, {
      "node_modules/a": { dependencies: { b: "1" } },
      "node_modules/b": {},
    })));
    const src = path.join(dir, "src");
    fs.mkdirSync(src, { recursive: true });
    for (const p of pkgs) {
      fs.mkdirSync(path.join(src, "node_modules", p), { recursive: true });
      fs.writeFileSync(path.join(src, "node_modules", p, "package.json"), "{}");
    }
    fs.writeFileSync(path.join(src, "main.js"), "");
    const appOutDir = path.join(dir, "out");
    const resources = path.join(appOutDir, "App.app", "Contents", "Resources");
    fs.mkdirSync(resources, { recursive: true });
    await asar.createPackage(src, path.join(resources, "app.asar"));
    return { electronPlatformName: "darwin", appOutDir, packager: { projectDir, appInfo: { productFilename: "App" } } };
  };

  it("passes when every package is present", async () => {
    await expect(verifyPackagedDeps(await makeCtx(["a", "b"]))).resolves.toBeUndefined();
  });

  it("rejects and names the missing package", async () => {
    const err = await verifyPackagedDeps(await makeCtx(["a"])).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("missing 1 production packages: b.");
    expect((err as Error).message).toContain("Run npm ci");
  });

  it("rejects a symlinked node_modules and warns about npm ci", async () => {
    const ctx = await makeCtx(["a", "b"]);
    const target = path.join(dir, "shared-node-modules");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(ctx.packager.projectDir, "node_modules"));
    const err = await verifyPackagedDeps(ctx).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("node_modules is a symlink");
    expect((err as Error).message).toContain("rm node_modules");
  });

  it("does nothing on non-darwin", async () => {
    const ctx = { electronPlatformName: "linux", appOutDir: "/nonexistent", packager: { projectDir: "/nonexistent", appInfo: { productFilename: "X" } } };
    await expect(verifyPackagedDeps(ctx)).resolves.toBeUndefined();
  });
});
