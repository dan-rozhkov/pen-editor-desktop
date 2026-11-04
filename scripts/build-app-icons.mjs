#!/usr/bin/env node
// Regenerates assets/app-icons/ from assets/app-icons/source/. macOS with Xcode only (actool, swift).
// Run by hand after a change to the artwork. The outputs are committed.
// `npm run dist` does not run this script, but it needs Xcode 26 or higher too: electron-builder compiles white.icon with actool.
//
// Each icon is an Icon Composer document (<id>.icon): macOS draws the corners, highlights and shadow itself, which
// keeps the mark's edges crisp. Do not bake glass effects into the layers (Apple HIG, "App icons").
// <id>.png is that same icon as macOS renders it: the Dock shows it through app.dock.setIcon().
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.resolve(import.meta.dirname, "../assets/app-icons");
const SOURCE = path.join(OUT, "source");
const MARK_SHARE = 620 / 1024; // height of the mark on the canvas
const MARK_BOX = { cx: 78.5, cy: 108.5, height: 225 }; // of mark.path.txt

const WHITE = "srgb:1.00000,1.00000,1.00000,1.00000";
const GRAPHITE = "srgb:0.09412,0.09412,0.10196,1.00000";
const ICONS = [
  { id: "white", fill: WHITE, mark: "#000000" },
  { id: "black", fill: GRAPHITE, mark: "#ffffff" },
  { id: "shader", fill: GRAPHITE, mark: "#ffffff", background: "shader-background.png" },
];

function markSvg(color) {
  const d = fs.readFileSync(path.join(SOURCE, "mark.path.txt"), "utf8").trim();
  const k = (1024 * MARK_SHARE) / MARK_BOX.height;
  const tx = (512 - MARK_BOX.cx * k).toFixed(2);
  const ty = (512 - MARK_BOX.cy * k).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><path transform="translate(${tx} ${ty}) scale(${k.toFixed(4)})" d="${d}" fill="${color}"/></svg>\n`;
}

function writeIconDocument(icon) {
  const dir = path.join(OUT, `${icon.id}.icon`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "Assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Assets/mark.svg"), markSvg(icon.mark));
  const flat = { shadow: { kind: "none", opacity: 0 }, translucency: { enabled: false, value: 0 } };
  const groups = [{ layers: [{ "image-name": "mark.svg", name: "mark", glass: false }], ...flat, specular: true }];
  if (icon.background) {
    fs.copyFileSync(path.join(SOURCE, icon.background), path.join(dir, "Assets", icon.background));
    groups.push({ layers: [{ "image-name": icon.background, name: "background", glass: false }], ...flat, specular: false });
  }
  const document = { fill: { solid: icon.fill }, groups, "supported-platforms": { squares: "shared" } };
  fs.writeFileSync(path.join(dir, "icon.json"), `${JSON.stringify(document, null, 2)}\n`);
  return dir;
}

/** A throwaway .app: NSWorkspace renders its icon the way the Dock and Finder do. */
function compileToApp(icon, documentDir, tmp) {
  const app = path.join(tmp, `${icon.id}-${process.pid}.app`);
  const resources = path.join(app, "Contents/Resources");
  fs.mkdirSync(resources, { recursive: true });
  execFileSync("actool", [documentDir, "--compile", resources, "--output-format", "human-readable-text",
    "--output-partial-info-plist", path.join(tmp, `${icon.id}.plist`), "--app-icon", icon.id, "--include-all-app-icons",
    "--enable-on-demand-resources", "NO", "--development-region", "en", "--target-device", "mac",
    "--minimum-deployment-target", "26.0", "--platform", "macosx"], { stdio: "inherit" });
  // Without an executable macOS does not treat the folder as an app and returns the generic icon.
  fs.mkdirSync(path.join(app, "Contents/MacOS"));
  fs.writeFileSync(path.join(app, "Contents/MacOS/x"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>sideform.icon-render.${icon.id}.${process.pid}</string><key>CFBundleName</key><string>${icon.id}</string><key>CFBundleExecutable</key><string>x</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIconName</key><string>${icon.id}</string><key>CFBundleIconFile</key><string>${icon.id}</string></dict></plist>\n`);
  return app;
}

const RENDER_SWIFT = `import AppKit
let args = CommandLine.arguments
let image = NSWorkspace.shared.icon(forFile: args[1])
let size = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
  hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
`;

const tmp = fs.mkdtempSync(path.join(OUT, ".render-"));
const swift = path.join(tmp, "render.swift");
fs.writeFileSync(swift, RENDER_SWIFT);
try {
  for (const icon of ICONS) {
    const app = compileToApp(icon, writeIconDocument(icon), tmp);
    execFileSync("swift", [swift, app, path.join(OUT, `${icon.id}.png`)], { stdio: "inherit" });
    console.log(`${icon.id}: ok`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
