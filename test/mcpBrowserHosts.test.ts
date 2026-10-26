import { describe, expect, it } from "vitest";
import type { BrowserBridge } from "@sideform/browser-agent/loop";
import { BrowserHostRegistry } from "../src/main/mcp/browserHosts";

const bridge = (): BrowserBridge => ({}) as BrowserBridge;

describe("BrowserHostRegistry", () => {
  it("has no host at first", () => {
    expect(new BrowserHostRegistry().current()).toBeNull();
  });

  it("treats the newest registered host as active", () => {
    const r = new BrowserHostRegistry();
    const a = bridge();
    const b = bridge();
    r.register(1, a);
    r.register(2, b);
    expect(r.current()).toBe(b);
  });

  it("switches to the host that is marked active", () => {
    const r = new BrowserHostRegistry();
    const a = bridge();
    const b = bridge();
    r.register(1, a);
    r.register(2, b);
    r.markActive(1);
    expect(r.current()).toBe(a);
    r.markActive(2);
    expect(r.current()).toBe(b);
  });

  it("ignores an unknown key", () => {
    const r = new BrowserHostRegistry();
    const a = bridge();
    r.register(1, a);
    r.markActive(99);
    expect(r.current()).toBe(a);
  });

  it("falls back to the previous most recent host after an unregister", () => {
    const r = new BrowserHostRegistry();
    const a = bridge();
    const b = bridge();
    const c = bridge();
    r.register(1, a);
    r.register(2, b);
    const unregisterC = r.register(3, c);
    r.markActive(2);
    r.markActive(3);
    unregisterC();
    expect(r.current()).toBe(b);
  });

  it("returns to null when the last host goes", () => {
    const r = new BrowserHostRegistry();
    const off = r.register(1, bridge());
    off();
    expect(r.current()).toBeNull();
    expect(r.size()).toBe(0);
  });

  it("keeps a replacement when a stale unregister runs", () => {
    const r = new BrowserHostRegistry();
    const oldOff = r.register(1, bridge());
    const fresh = bridge();
    r.register(1, fresh);
    oldOff();
    expect(r.current()).toBe(fresh);
  });
});
