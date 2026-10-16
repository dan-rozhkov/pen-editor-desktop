import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOGIN_CAPTURE_BINDING, isLoginBindingCall } from "../src/main/browser/loginCapture";

describe("isLoginBindingCall", () => {
  it("is true only for the login binding's Runtime.bindingCalled", () => {
    expect(isLoginBindingCall("Runtime.bindingCalled", { name: LOGIN_CAPTURE_BINDING, payload: "x" })).toBe(true);
    expect(isLoginBindingCall("Runtime.bindingCalled", { name: "other" })).toBe(false);
    expect(isLoginBindingCall("Runtime.bindingCalled", null)).toBe(false);
    expect(isLoginBindingCall("Page.frameNavigated", { name: LOGIN_CAPTURE_BINDING })).toBe(false);
  });
});

// Structural: window.ts must consume the login binding BEFORE the generic
// listener fan-out, because the payload holds a plaintext password.
describe("window.ts routes the login binding before any other listener", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/main/window.ts"), "utf8");
  const handler = src.slice(src.indexOf('debugger.on("message"'));

  it("checks isLoginBindingCall, returns, and only then fans out to cdpEventListeners", () => {
    const check = handler.indexOf("isLoginBindingCall(method, params)");
    const fanOut = handler.indexOf("for (const l of [...cdpEventListeners])");
    expect(check).toBeGreaterThan(-1);
    expect(fanOut).toBeGreaterThan(check);
    // an early return sits between the check and the fan-out
    expect(handler.slice(check, fanOut)).toMatch(/return;/);
  });
});
