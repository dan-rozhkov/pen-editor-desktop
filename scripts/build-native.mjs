// Builds native/bin/sideform-computer-use (universal arm64 + x86_64) from native/computer-use/*.swift.
// A no-op with a warning off macOS or without swiftc, so Linux CI never needs Swift.
// Usage: node scripts/build-native.mjs [--force]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "native", "computer-use");
const binDir = join(root, "native", "bin");
const out = join(binDir, "sideform-computer-use");
const force = process.argv.includes("--force");
const FRAMEWORKS = ["AppKit", "ApplicationServices", "ScreenCaptureKit", "CoreGraphics"];

function warn(msg) {
  console.warn(`[build-native] ${msg}`);
}

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
}

if (process.platform !== "darwin") {
  warn(`skipped: computer use helper is macOS only (platform ${process.platform}).`);
  process.exit(0);
}
if (spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status !== 0) {
  warn("skipped: swiftc not found (install the Xcode command line tools).");
  process.exit(0);
}

const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith(".swift"))
  .sort()
  .map((f) => join(srcDir, f));
if (sources.length === 0) {
  warn("no Swift sources found.");
  process.exit(1);
}

if (!force && existsSync(out)) {
  const binTime = statSync(out).mtimeMs;
  if (sources.every((s) => statSync(s).mtimeMs <= binTime)) {
    console.log("[build-native] up to date (use --force to rebuild).");
    process.exit(0);
  }
}

mkdirSync(binDir, { recursive: true });

function compile(arch) {
  const slice = join(binDir, `sideform-computer-use.${arch}`);
  const args = [
    "-swift-version", "5",
    "-O",
    "-target", `${arch}-apple-macos14`,
    ...FRAMEWORKS.flatMap((f) => ["-framework", f]),
    ...sources,
    "-o", slice,
  ];
  const ok = run("swiftc", args).status === 0 && existsSync(slice);
  return ok ? slice : null;
}

const arm = compile("arm64");
if (!arm) {
  console.error("[build-native] arm64 build failed.");
  process.exit(1);
}
const x86 = compile("x86_64");
const slices = [arm];
if (x86) {
  slices.push(x86);
} else {
  warn("x86_64 slice failed to build (SDK?); shipping an arm64-only helper.");
}

let status;
if (slices.length === 2) {
  status = run("lipo", ["-create", ...slices, "-output", out]).status;
} else {
  rmSync(out, { force: true });
  status = run("cp", [arm, out]).status;
}
for (const s of slices) rmSync(s, { force: true });
if (status !== 0) {
  console.error("[build-native] could not assemble the binary.");
  process.exit(1);
}
if (run("codesign", ["--force", "-s", "-", out]).status !== 0) {
  console.error("[build-native] codesign failed.");
  process.exit(1);
}
console.log(`[build-native] built ${out} (${slices.length === 2 ? "arm64 + x86_64" : "arm64 only"}).`);
