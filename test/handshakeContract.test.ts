import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cross-repo contract: `src/main/mcp/handshake.ts` is a verbatim copy of
 * pen-editor-backend/src/mcp/autoToken.ts's handshake-file half (see that
 * file's own header comment). The path, the file/dir modes, and the entry's
 * key names are the wire contract pen-editor-plugin/lib/proxy.mjs also
 * depends on — a silent drift here breaks discovery for every user with no
 * runtime error anywhere near the edit.
 *
 * Mirrors the sibling-checkout pattern in
 * pen-editor/src/lib/__tests__/desktopMenuContract.test.ts: read the
 * sibling repo's source as text (no import — autoToken.ts pulls in
 * ../config.js, which this repo has no reason to compile), and assert the
 * literals this repo's copy encodes still appear there. When the sibling
 * checkout is absent, the suite is skipped rather than failed — there is no
 * CONTRACT_REQUIRE_BACKEND-style mandatory job for this repo (it has no CI
 * of its own, per CLAUDE.md), so failing hard here would only ever fire on
 * a machine that happens not to have ../pen-editor-backend checked out.
 */

// Vitest runs with cwd = pen-editor-desktop/, the sibling backend repo lives
// next to it.
const backendAutoTokenPath = resolve(process.cwd(), "../pen-editor-backend/src/mcp/autoToken.ts");
const backendExists = existsSync(backendAutoTokenPath);

const thisAutoTokenPath = resolve(process.cwd(), "src/main/mcp/handshake.ts");
const thisSrc = readFileSync(thisAutoTokenPath, "utf8");

describe("handshake contract literals (pinned, always runs)", () => {
  it("this repo's copy still encodes the documented path/mode/key contract", () => {
    expect(thisSrc).toContain('".pen-editor"');
    expect(thisSrc).toContain('"mcp.json"');
    expect(thisSrc).toContain("0o700");
    expect(thisSrc).toContain("0o600");
    expect(thisSrc).toMatch(/url:\s*string/);
    expect(thisSrc).toMatch(/token:\s*string/);
    expect(thisSrc).toMatch(/port:\s*number/);
  });
});

describe.runIf(backendExists)("handshake contract sync with pen-editor-backend", () => {
  const backendSrc = backendExists ? readFileSync(backendAutoTokenPath, "utf8") : "";

  it("path literals match", () => {
    expect(backendSrc).toContain('".pen-editor"');
    expect(backendSrc).toContain('"mcp.json"');
    expect(thisSrc).toContain('".pen-editor"');
    expect(thisSrc).toContain('"mcp.json"');
  });

  it("file/dir modes match (0700 dir, 0600 file)", () => {
    expect(backendSrc).toContain("0o700");
    expect(backendSrc).toContain("0o600");
    expect(thisSrc).toContain("0o700");
    expect(thisSrc).toContain("0o600");
  });

  it("HandshakeFileEntry key names match", () => {
    for (const key of ["url: string", "token: string", "port: number"]) {
      expect(backendSrc).toContain(key);
      expect(thisSrc).toContain(key);
    }
  });

  it("both write atomically (temp file + rename)", () => {
    expect(backendSrc).toContain(".tmp");
    expect(backendSrc).toMatch(/rename\(/);
    expect(thisSrc).toContain(".tmp");
    expect(thisSrc).toMatch(/rename\(/);
  });

  it("both derive the handshake dir from os.homedir() joined with the same segment", () => {
    expect(backendSrc).toMatch(/join\(homedir\(\),\s*"\.pen-editor"\)/);
    expect(thisSrc).toMatch(/join\(homedir\(\),\s*"\.pen-editor"\)/);
  });
});

describe.runIf(!backendExists)("handshake contract sync with pen-editor-backend (skipped)", () => {
  it.skip("../pen-editor-backend not found next to pen-editor-desktop", () => {});
});
