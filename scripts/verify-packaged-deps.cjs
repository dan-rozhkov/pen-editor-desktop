"use strict";
// electron-builder `afterPack` hook. It fails the build when node_modules is a
// symlink or when app.asar lacks a production dependency. electron-builder's dependency collector silently keeps
// only the direct dependencies when node_modules is a symlink and npm's hidden
// lockfile is stale. The build still exits 0, and the app then crashes at launch
// with ERR_MODULE_NOT_FOUND (this shipped in 0.9.6 and 0.9.7).
const fs = require("node:fs");
const path = require("node:path");

/** Names of all packages that must be packaged: the runtime `dependencies` closure. */
function expectedProdPackages(lock) {
  const packages = lock.packages || {};
  const root = packages[""];
  if (!root) throw new Error('package-lock.json has no root entry ("")');

  const resolveDep = (fromKey, name) => {
    let base = fromKey;
    for (;;) {
      const key = base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`;
      if (packages[key]) return key;
      if (base === "") return null;
      const idx = base.lastIndexOf("/node_modules/");
      base = idx === -1 ? "" : base.slice(0, idx);
    }
  };

  const names = new Set();
  const seen = new Set();
  const visit = (fromKey, depNames) => {
    for (const name of depNames) {
      const key = resolveDep(fromKey, name);
      if (key === null) {
        throw new Error(`Required dependency "${name}" (needed by "${fromKey || "root"}") is missing from package-lock.json`);
      }
      names.add(name);
      if (seen.has(key)) continue;
      seen.add(key);
      visit(key, Object.keys(packages[key].dependencies || {}));
    }
  };
  visit("", Object.keys(root.dependencies || {}));
  return [...names].sort();
}

/** Package names that have node_modules/<name>/package.json at any depth. */
function packagedPackages(paths) {
  const names = new Set();
  for (const raw of paths) {
    const parts = raw.split(/[\\/]+/).filter(Boolean);
    if (parts[parts.length - 1] !== "package.json") continue;
    const dir = parts.slice(0, -1);
    const idx = dir.lastIndexOf("node_modules");
    if (idx === -1) continue;
    const rest = dir.slice(idx + 1);
    if (rest.length === 1 && !rest[0].startsWith("@")) names.add(rest[0]);
    else if (rest.length === 2 && rest[0].startsWith("@")) names.add(`${rest[0]}/${rest[1]}`);
  }
  return [...names].sort();
}

function findMissingPackages(expected, packaged) {
  const have = new Set(packaged);
  return expected.filter((name) => !have.has(name));
}

async function verifyPackagedDeps(context) {
  if (context.electronPlatformName !== "darwin") return;
  const nodeModules = path.join(context.packager.projectDir, "node_modules");
  if (fs.lstatSync(nodeModules, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(
      "node_modules is a symlink. electron-builder can collect an incomplete dependency tree from it.\n" +
        "Delete the symlink with rm node_modules. Then run npm ci and build again.\n" +
        "Do not run npm ci while the symlink exists: npm ci follows the link and erases the target.",
    );
  }
  const { listPackage } = require("@electron/asar");
  const lockPath = path.join(context.packager.projectDir, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const asarPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Resources",
    "app.asar",
  );
  const expected = expectedProdPackages(lock);
  const missing = findMissingPackages(expected, packagedPackages(listPackage(asarPath)));
  if (missing.length > 0) {
    throw new Error(
      `Packaged app is missing ${missing.length} production packages: ${missing.join(", ")}.\n` +
        "electron-builder collected an incomplete dependency tree. The app will crash at launch.\n" +
        "Run npm ci in this directory and build again.",
    );
  }
  console.log(`  • verified ${expected.length} production packages in app.asar`);
}

module.exports = { afterPack: verifyPackagedDeps, expectedProdPackages, packagedPackages, findMissingPackages };
